// SPDX-License-Identifier: Apache-2.0
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// An owned inert OpenAI-compatible endpoint proves the pinned Pi transport and
// JSON file-proposal contract. It does not claim a real model authored a change.
const directory = await mkdtemp(join(tmpdir(), 'confidence-pi-smoke-'));
const content = 'export const cacheTtlMs = 60000;\n';
let requests = 0;
const server = http.createServer(async (request, response) => {
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer owned-mock-token');
  let body = ''; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body); assert.equal(input.model, 'owned-mock'); requests++;
  const result = JSON.stringify({ files: { 'cache.mjs': requests === 1 ? 'export const = ;\n' : content }, rationale: 'Owned transport test response.' });
  if (requests === 2) assert(input.messages.some((message: any) => JSON.stringify(message).includes('untrustedDiagnostics')));
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1791150000, model: 'owned-mock', choices: [{ index: 0, delta: { role: 'assistant', content: result }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1791150000, model: 'owned-mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
try {
  await mkdir(join(directory, 'home'));
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ agentDir: join(directory, 'pi'), brokerUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, brokerToken: 'owned-mock-token', model: 'owned-mock', prompt: 'Return a proposal for cache.mjs.', allowedPaths: ['cache.mjs'] }));
  const child = spawn(process.execPath, [resolve('services/pi-child.mjs'), config], { cwd: directory, env: { PATH: process.env.PATH, HOME: join(directory, 'home'), PI_OFFLINE: '1', TZ: 'UTC', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  child.stdout!.on('data', bytes => { if (output.length < 256 * 1024) output += bytes.toString(); else child.kill('SIGKILL'); });
  child.stderr!.on('data', bytes => { if (stderr.length < 8192) stderr += bytes.toString(); });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30000);
  const code = await new Promise<number>((resolveExit, reject) => { child.once('error', reject); child.once('close', value => { clearTimeout(deadline); resolveExit(value ?? 1); }); });
  assert.equal(code, 0, stderr);
  assert.equal(await readFile(join(directory, 'cache.mjs'), 'utf8'), content);
  const result = JSON.parse(output.trim());
  assert.equal(result.type, 'model_result'); assert.equal(requests, 2); assert.equal(result.modelCalls, 2);
  assert.equal(result.diagnostics[0].status, 'FAIL'); assert.equal(result.diagnostics[1].status, 'PASS');
  assert(result.diagnostics.every((record: any) => record.acceptanceEligible === false && record.generation === '1' && record.sourceCoherence === 'COHERENT'));
  const sessionBytes = await readFile(join(directory, 'pi', 'session.json'));
  assert.equal(result.session.digest, 'sha256:' + createHash('sha256').update(sessionBytes).digest('hex'));
  const retained = JSON.parse(sessionBytes.toString()); assert.equal(retained.complete, true); assert.equal(retained.prompts.length, 2);
  assert.equal(retained.selectedEntry, result.session.selectedEntry); assert(retained.entries.length >= 4);
  process.stdout.write(JSON.stringify({ passed: true, sdk: '1.0.2', requests, checks: ['explicit model route', 'in-session correction after actual Node syntax failure', 'attributed diagnostic source/generation binding', 'retained actual SDK entries/selected leaf/digest', 'no discovered tools or resources'], limitation: 'Owned mock response; no real model quality or provider call demonstrated.' }) + '\n');
} finally { server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); await rm(directory, { recursive: true, force: true }); }
