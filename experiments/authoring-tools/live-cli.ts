// SPDX-License-Identifier: Apache-2.0
// Explicit operator adapter. Reads one normal Access JWT from stdin only.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveBenchmark, validateLivePlan, type LivePlan, type LiveTransport } from './live.ts';

async function boundedJsonFile(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(); assert(info.isFile() && info.size <= 65536, 'Operator input must be a bounded regular JSON file');
    const raw = Buffer.alloc(65537), { bytesRead } = await handle.read(raw); assert(bytesRead <= 65536);
    return JSON.parse(raw.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

export function accessTransport(origin: string, token: string, fetcher: typeof fetch = fetch): LiveTransport['fetch'] {
  assert(token.length >= 32 && token.length <= 16384 && /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(token), 'Expected one Access application JWT on stdin');
  return async (url, init) => {
    const parsed = new URL(url);
    assert(parsed.origin === origin && (parsed.pathname === '/api/session' || /^\/v1\/projects\/[a-zA-Z0-9_-]+\//.test(parsed.pathname)), 'Authentication destination outside registered application');
    const headers = new Headers(init.headers); headers.set('cf-access-token', token);
    return fetcher(url, { ...init, headers, redirect: 'error' });
  };
}

export async function verifyReadback(path: string, plan: LivePlan, arm: string, now = Date.now()) {
  const value = await boundedJsonFile(path);
  assert(value.schemaVersion === 1 && value.origin === plan.origin && value.arm === arm, 'Readback scope/arm mismatch');
  const observed = Date.parse(value.completedAt);
  assert(Number.isFinite(observed) && observed <= now && now - observed <= 15 * 60 * 1000, 'Fresh completed deployment readback required');
  return value.deployment;
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 9 && args[0] === '--approved-real-model' && args[1] === '--plan' && args[3] === '--out' && args[5] === '--readback' && args[7] === '--origin',
    'Usage: live-cli.ts --approved-real-model --plan /private/plan.json --out /new/private/run --readback /private/fresh-readback.json --origin https://approved-app (Access JWT on stdin)');
  const plan = await boundedJsonFile(resolve(args[2])) as LivePlan; validateLivePlan(plan);
  assert.equal(plan.origin, args[8], 'Explicit credential destination must equal the registered origin');
  assert.equal(plan.arms.length, 1, 'CLI runs one explicitly selected arm; use the operator library to coordinate matched mode changes');
  let token = '';
  const timer = setTimeout(() => process.stdin.destroy(new Error('ACCESS_STDIN_TIMEOUT')), 10000);
  try { for await (const chunk of process.stdin) { token += chunk; assert(Buffer.byteLength(token) <= 16384, 'ACCESS_STDIN_LIMIT'); } } finally { clearTimeout(timer); }
  const authenticated = accessTransport(plan.origin, token.trim()); token = '';
  const response = await authenticated(plan.origin + '/api/session', { signal: AbortSignal.timeout(10000) });
  assert(response.ok && response.headers.get('content-type')?.includes('application/json'), 'Verified application session unavailable');
  const reader = response.body!.getReader(); let raw = '';
  try { while (true) { const item = await reader.read(); if (item.done) break; raw += Buffer.from(item.value); assert(Buffer.byteLength(raw) <= 16384, 'SESSION_RESPONSE_LIMIT'); } } finally { await reader.cancel().catch(() => undefined); }
  const session = JSON.parse(raw); assert.equal(session.credentialClass, 'human'); assert.equal(session.principalId, plan.principalId, 'Authenticated principal differs from registration');
  const benchmark = await LiveBenchmark.create(plan, resolve(args[4]), { fetch: authenticated, verifyDeployment: (registered, arm) => verifyReadback(resolve(args[6]), registered, arm) }, 'APPROVED_REAL_MODEL_BENCHMARK');
  try {
    const result = await benchmark.runNextArm();
    process.stdout.write(JSON.stringify({ status: result.status, arm: result.arm, reportDirectory: resolve(args[4]), modelCalls: result.modelCalls ?? null,
      actualBilledCostMicroUsd: null, needsOperatorReconciliation: result.needsOperatorReconciliation ?? false }) + '\n');
    if (result.needsOperatorReconciliation) process.exitCode = 1;
  } finally { await benchmark.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('BENCHMARK_CLI_FAILED: inspect retained operator evidence; no automatic retry performed.\n'); process.exitCode = 1; });
}
