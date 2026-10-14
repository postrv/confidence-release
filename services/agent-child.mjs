// Host-selected deterministic authoring recipe. This is scripted, never an LLM.
import { readFile, writeFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify({ type: 'started', adapter: 'scripted-fixture-v1', role: config.role }) + '\n');
// Deliberately overlapping wall time makes the three real processes observable.
await new Promise(resolve => setTimeout(resolve, config.delayMs || 700));
if (config.role === 'A') {
  const file = await readFile('cache.mjs', 'utf8');
  await writeFile('cache.mjs', file.replace('export const cacheTtlMs = 0;', 'export const cacheTtlMs = 60000;'));
} else if (config.role === 'B') {
  const file = await readFile('mutation.mjs', 'utf8');
  await writeFile('mutation.mjs', file.replace('  invalidate();', '  // Removed: caching is disabled in the pinned work base.'));
} else if (config.role === 'C') {
  await writeFile('presentation.mjs', 'export function renderStatus(value) {\n  return `<!doctype html><html lang="en"><head><title>Shared value</title></head><body><main><h1>Shared value</h1><p role="status" aria-live="polite" aria-label="Saved value">Saved value: ${value}</p></main></body></html>`;\n}\n');
} else if (config.role === 'repair') {
  const file = await readFile('mutation.mjs', 'utf8');
  await writeFile('mutation.mjs', file.replace('  // Removed: caching is disabled in the pinned work base.', '  invalidate();'));
} else throw new Error('Unknown registered role');
process.stdout.write(JSON.stringify({ type: 'submitted', adapter: 'scripted-fixture-v1', intent: config.assignment, contextDigest: config.contextDigest }) + '\n');
