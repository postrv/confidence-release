// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizeModelRequest, workersAiBindingInput, workersAiFailureDiagnostic, workersAiResponseIdentity,
  WORKERS_AI_LEGACY_CODING_MODEL,
} from './model-policy.ts';
import { errorResponse, PlatformError } from '../shared/errors.ts';
import { modelResponseLifetime, modelResponseStream } from './model-response-stream.ts';

// Exercise the pinned SDK against the production model policy and the same
// full-response SSE shape used by the runner. Inference is an owned fixture;
// this does not establish a Workers AI response or deployed container behavior.
async function runCorrection(reasoningBytes: number, terminalFailure?: 'retention' | 'deadline') {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-pi-production-policy-'));
  const model = WORKERS_AI_LEGACY_CODING_MODEL;
  const original = 'export const repaired = false;\n';
  const proposed = 'export const repaired = true;\n';
  const rejectedText = "const fs = require('fs'); fs.writeFileSync('shell-canary', 'must-not-run');";
  const reasoning = 'r'.repeat(reasoningBytes);
  const handlerErrors: unknown[] = [];
  const policyRejections: string[] = [];
  const providerRequests: ReturnType<typeof workersAiBindingInput>[] = [];
  let requests = 0, observedReasoningHistory = false;
  let comments = 0;
  const streamFailures: unknown[] = [];
  const endpoint = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer owned-attempt-only');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert(bytes <= 192 * 1024, 'the SDK request fits the production broker input bound');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      requests++;
      assert(requests <= 4, 'one authoring attempt permits at most four model admissions');
      assert.equal(input.model, model);
      assert.equal(input.max_completion_tokens, 8192);
      assert.equal(await readFile(join(directory, 'file.mjs'), 'utf8'), original,
        'neither the invalid proposal nor its reasoning may write source');
      if (requests === 2) {
        const assistant = input.messages.find((message: any) => message.role === 'assistant');
        assert.equal(assistant.content, rejectedText);
        assert.equal(assistant.reasoning_content, reasoning);
        observedReasoningHistory = true;
        const correction = input.messages.at(-1);
        assert.equal(correction.role, 'user');
        assert.match(JSON.stringify(correction.content), /required JSON file-proposal format/);
        assert.doesNotMatch(JSON.stringify(correction.content), /shell-canary/);
      }

      const normalized = normalizeModelRequest(input, model, 'max_completion_tokens', 'low');
      assert.equal(normalized.requestedStream, true);
      const bindingInput = workersAiBindingInput(normalized.request);
      assert.equal(bindingInput.max_completion_tokens, 8192);
      assert.equal(bindingInput.reasoning_effort, 'low');
      assert.equal(bindingInput.stream, false);
      assert.equal(bindingInput.store, false);
      assert(!JSON.stringify(normalized.request).includes('reasoning_content'),
        'normalized retained requests exclude assistant reasoning history');
      assert(!JSON.stringify(bindingInput).includes('reasoning_content'),
        'the provider binding never receives assistant reasoning history');
      providerRequests.push(bindingInput);

      const result = {
        id: `owned-production-policy-${requests}`, object: 'chat.completion', created: 1, model,
        choices: [{ index: 0, message: { role: 'assistant',
          content: requests === 1 ? rejectedText : JSON.stringify({ files: { 'file.mjs': proposed }, rationale: 'Owned correction fixture.' }),
          ...(requests === 1 ? { reasoning_content: reasoning } : {}),
        }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      };
      const body = new TextEncoder().encode(JSON.stringify(result));
      assert(body.length <= 512 * 1024, 'the response fits the production broker response bound');
      const observed = workersAiResponseIdentity(body, model);
      assert.equal(observed.reportedModel, model);
      assert.equal(observed.responseId, result.id);
      assert.deepEqual(observed.usage, result.usage);
      const client = new AbortController();
      request.once('aborted', () => client.abort());
      response.once('close', () => { if (!response.writableEnded) client.abort(); });
      const task = modelResponseStream({ lifetime: modelResponseLifetime(client.signal, terminalFailure === 'deadline' ? 30 : 2000), heartbeatMs: 10,
        produce: async signal => {
          if (terminalFailure === 'deadline') return new Promise<Uint8Array>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
          await new Promise(resolve => setTimeout(resolve, 40));
          if (terminalFailure === 'retention') throw new Error('owned private retention failure');
          return body;
        }, onFailure: (_error, reason) => streamFailures.push(reason ?? 'retention') });
      response.writeHead(task.response.status, Object.fromEntries(task.response.headers));
      const reader = task.response.body!.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (new TextDecoder().decode(next.value).startsWith(':')) comments++;
        response.write(next.value);
      }
      response.end();
      await task.completion;
    } catch (error) {
      if (error instanceof PlatformError && error.code === 'MODEL_MESSAGES_DENIED') {
        policyRejections.push(error.code);
        assert.deepEqual(workersAiFailureDiagnostic(error),
          { name: 'Error', code: 'MODEL_MESSAGES_DENIED', status: 403, category: 'broker-policy' });
        const rejection = errorResponse(error);
        response.writeHead(rejection.status, Object.fromEntries(rejection.headers));
        response.end(await rejection.text());
      } else {
        handlerErrors.push(error);
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'OWNED_FIXTURE_FAILED' }));
      }
    }
  });
  try {
    await new Promise<void>((accept, reject) => {
      endpoint.once('error', reject);
      endpoint.listen(0, '127.0.0.1', accept);
    });
    await writeFile(join(directory, 'file.mjs'), original);
    const agentDir = join(directory, 'agent');
    const address = endpoint.address();
    assert(address && typeof address === 'object');
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      agentDir, brokerUrl: `http://127.0.0.1:${address.port}/v1`, brokerToken: 'owned-attempt-only',
      model, allowedPaths: ['file.mjs'], generation: '1', prompt: 'Return the complete file.mjs proposal as JSON.',
    }));
    const child = spawn(process.execPath, [resolve('services/pi-child.mjs'), join(directory, 'config.json')], {
      // Generated Worker bindings augment ProcessEnv; this Node child must
      // deliberately receive only the owned test environment, never bindings.
      cwd: directory, env: { PATH: process.env.PATH, HOME: join(directory, '.home'), PI_OFFLINE: '1' } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const code = await new Promise<number | null>((accept, reject) => {
      child.once('error', reject);
      child.once('close', accept);
    }).finally(() => clearTimeout(timeout));
    assert.deepEqual(handlerErrors, [], output);
    assert(comments > 0, 'the pinned SDK receives keepalive comments before a terminal packet');
    if (terminalFailure) {
      assert.equal(requests, 1, 'a streamed error must not trigger another model request');
      assert.notEqual(code, 0, output);
      assert.match(output, /MODEL_TURN_FAILED/);
      assert.doesNotMatch(output, /private retention/);
      assert.deepEqual(streamFailures, [terminalFailure]);
      assert.equal(await readFile(join(directory, 'file.mjs'), 'utf8'), original);
      await assert.rejects(readFile(join(agentDir, 'session.json')), { code: 'ENOENT' });
      const partial = JSON.parse(await readFile(join(agentDir, 'partial-session.json'), 'utf8'));
      assert.equal(partial.complete, false);
      assert.equal(partial.prompts.length, 1);
      assert(partial.messages.some((message: any) => message.role === 'assistant' && message.stopReason === 'error'));
      return;
    }
    assert.deepEqual(streamFailures, []);
    assert.equal(requests, 2, output);
    assert.equal(observedReasoningHistory, true);
    await assert.rejects(readFile(join(directory, 'shell-canary')), { code: 'ENOENT' });
    const source = await readFile(join(directory, 'file.mjs'), 'utf8');
    if (reasoningBytes <= 64 * 1024) {
      assert.equal(code, 0, output);
      assert.deepEqual(policyRejections, []);
      assert.equal(providerRequests.length, 2);
      assert.equal(source, proposed);
      const result = JSON.parse(output.trim());
      assert.equal(result.modelCalls, 2);
      assert.equal(result.adapter, 'pi-sdk-1.0.2-json-proposal-v1');
      const session = JSON.parse(await readFile(join(agentDir, 'session.json'), 'utf8'));
      assert.equal(session.complete, true);
      assert.equal(session.prompts.length, 2);
      assert.equal(session.messages.filter((message: any) => message.role === 'assistant').length, 2);
    } else {
      assert.notEqual(code, 0, output);
      assert.match(output, /MODEL_TURN_FAILED_403_MODEL_MESSAGES_DENIED/);
      assert(!output.includes(reasoning), 'Pi failure logs exclude the rejected reasoning history');
      assert.deepEqual(policyRejections, ['MODEL_MESSAGES_DENIED']);
      assert.equal(providerRequests.length, 1, 'the oversized continuation is rejected before provider dispatch');
      assert.equal(source, original);
      assert(!output.includes('"type":"model_result"'));
      await assert.rejects(readFile(join(agentDir, 'session.json')), { code: 'ENOENT' });
      const partial = JSON.parse(await readFile(join(agentDir, 'partial-session.json'), 'utf8'));
      assert.equal(partial.complete, false);
      assert.equal(partial.prompts.length, 2);
    }
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>(accept => endpoint.close(() => accept()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('pinned Pi corrects a malformed reasoning-bearing response through the production broker policy', { timeout: 30_000 }, async () => {
  // The live failure had 2,097 reasoning characters; these inert bytes keep the
  // transport shape without copying any private model or repository content.
  await runCorrection(2097);
});

test('pinned Pi continuation preserves the production assistant reasoning-history limit', { timeout: 30_000 }, async () => {
  await runCorrection(64 * 1024 + 1);
});

for (const failure of ['retention', 'deadline'] as const) test(`pinned Pi treats a streamed ${failure} failure as incomplete, with no retry or source write`, { timeout: 30_000 }, async () => {
  await runCorrection(0, failure);
});
