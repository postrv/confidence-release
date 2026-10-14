// SPDX-License-Identifier: Apache-2.0
import type { Journal, Report } from './types';
const canonical = (value: any): string => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
export const deployedRuntimeInputs = ['worker.ts', 'types.ts', 'child-observation.ts', 'Dockerfile', 'inert.mjs', 'network.mjs', 'child.mjs', 'heartbeat-observation.mjs', 'wrangler.jsonc', 'package-lock.json'] as const;
export function continuationEligible(journal: Journal, original: Report, config: any, template: any, hashes: Record<string, string>, account: string, now: number, paths: { worker: string; dockerfile: string; directory: string }): boolean {
  const before = original.journal;
  if (!before || original.providerGatePassed || !['BLOCKED', 'FAIL'].includes(original.status) || !before.accountId || before.accountId !== account || journal.accountId !== account) return false;
  for (const state of [before, journal]) if (state.deploy !== 'ACKNOWLEDGED' || state.start !== 'NOT_DISPATCHED' || state.stop !== 'NOT_DISPATCHED' || state.workerDelete !== 'NOT_DISPATCHED') return false;
  if (['runId', 'workerName', 'containerName', 'endpoint'].some(key => (before as any)[key] !== (journal as any)[key])) return false;
  if (deployedRuntimeInputs.some(path => !hashes[path] || original.sourceDigests[path] !== hashes[path])) return false;
  const expiry = config?.vars?.RUN_EXPIRES_AT;
  if (typeof expiry !== 'string' || !/^[0-9]{13}$/.test(expiry) || Number(expiry) <= now || Number(expiry) > now + 600_000 || config.vars.RUN_ID !== journal.runId) return false;
  const expected = structuredClone(template); expected.name = journal.workerName; expected.account_id = account; expected.main = paths.worker;
  expected.containers[0].name = journal.containerName; expected.containers[0].images.inert = { dockerfile: paths.dockerfile, build_context: paths.directory };
  expected.vars = { RUN_ID: journal.runId, RUN_EXPIRES_AT: expiry };
  return canonical(config) === canonical(expected);
}
export async function deployedWorkerMatches(response: Response, expected: Uint8Array): Promise<boolean> {
  if (response.status !== 200 || !response.body) return false;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 256 * 1024) { await reader.cancel(); return false; } chunks.push(next.value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let actual = bytes;
  if (response.headers.get('content-type')?.startsWith('multipart/')) {
    const form = await new Response(bytes, { headers: response.headers }).formData();
    const entrypoint = response.headers.get('cf-entrypoint'); if (entrypoint !== 'worker.js') return false;
    const names = Array.from(form.keys()); if (new Set(names).size !== names.length || names.some(name => !['worker.js', 'worker.js.map'].includes(name))) return false;
    const main = form.get('worker.js'); if (!(main instanceof File)) return false; actual = new Uint8Array(await main.arrayBuffer());
  } else if (!response.headers.get('content-type')?.includes('javascript')) return false;
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}
export function deployedVariablesMatch(settings: unknown, config: any): boolean {
  const result = settings as { success?: unknown; result?: { bindings?: { type?: string; name?: string; text?: string }[]; compatibility_date?: string; compatibility_flags?: string[] } };
  const settingsResult = result.result; const bindings = settingsResult?.bindings;
  return result.success === true && Array.isArray(bindings) && ['RUN_ID', 'RUN_EXPIRES_AT'].every(name => bindings.filter(binding => binding.name === name && binding.type === 'plain_text' && binding.text === config.vars[name]).length === 1) &&
    settingsResult?.compatibility_date === config.compatibility_date && canonical(settingsResult?.compatibility_flags ?? []) === canonical(config.compatibility_flags);
}
