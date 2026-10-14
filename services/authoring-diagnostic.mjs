// SPDX-License-Identifier: Apache-2.0
// Fixed public feedback inside the current writable authoring generation.
// Its output is diagnostic, including when the command exits successfully.
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const checks = [];
const limit = { maximumPaths: 16, maximumOutputBytes: 16384, syntaxTimeoutMs: 2000, protectedAcceptance: false };
const record = (name, status, summary) => checks.push({ name, status, summary: summary.slice(0, 1024) });
const paths = process.argv.slice(2);
const workspace = await realpath(process.cwd());
function safePath(path) { return typeof path === 'string' && path.length <= 256 && /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.mjs$/.test(path) && !path.split('/').some(part => part === '.' || part === '..') && !path.startsWith('-'); }
async function regular(path) {
  const absolute = resolve(workspace, path);
  const info = await lstat(absolute);
  if (!info.isFile() || info.size > 1024 * 1024 || !(await realpath(absolute)).startsWith(`${workspace}${sep}`)) throw new Error('SOURCE_PATH_UNAVAILABLE');
  return absolute;
}
async function syntax(path) {
  const absolute = await regular(path);
  return new Promise(resolveResult => {
    let settled = false, bytes = 0, timedOut = false, oversized = false;
    const child = spawn(process.execPath, ['--check', absolute], { stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = code => { if (settled) return; settled = true; clearTimeout(timer); resolveResult(timedOut || oversized || code === null ? 'ERROR' : code === 0 ? 'PASS' : 'FAIL'); };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, limit.syntaxTimeoutMs);
    const drain = chunk => { bytes += chunk.length; if (bytes > limit.maximumOutputBytes) { oversized = true; child.kill('SIGKILL'); } };
    child.stdout.on('data', drain); child.stderr.on('data', drain);
    child.once('close', finish); child.once('error', () => finish(null));
  });
}

try {
  if (!paths.length || paths.length > limit.maximumPaths || new Set(paths).size !== paths.length || paths.some(path => !safePath(path))) throw new Error('UNSUPPORTED_PATH_PROFILE');
  for (const path of paths) {
    const status = await syntax(path);
    record(`syntax:${path}`, status, status === 'PASS' ? `Node syntax check passed for ${path}.` : status === 'FAIL' ? `Node syntax check found invalid JavaScript in ${path}.` : `The bounded syntax check could not establish a result for ${path}.`);
  }
  // This is a deliberately small public API check with an in-memory fixture.
  // It has no access to evaluator credentials, protected cases or their results.
  let supported = true;
  for (const path of ['cache.mjs', 'mutation.mjs', 'presentation.mjs', 'server.mjs']) {
    try { await regular(path); } catch { supported = false; }
  }
  if (!supported) record('public-read-write-read', 'SKIPPED', 'The complete four-file demo profile is unavailable; only declared-path syntax feedback ran.');
  else if (checks.some(check => check.status !== 'PASS')) record('public-read-write-read', 'SKIPPED', 'Fix syntax diagnostics before the focused public demo probe.');
  else {
    try {
      const cache = await import(pathToFileURL(resolve(workspace, 'cache.mjs')).href);
      const mutation = await import(pathToFileURL(resolve(workspace, 'mutation.mjs')).href);
      const presentation = await import(pathToFileURL(resolve(workspace, 'presentation.mjs')).href);
      if (typeof cache.readValue !== 'function' || typeof mutation.writeValue !== 'function' || typeof presentation.renderStatus !== 'function') throw new Error('PUBLIC_API_UNAVAILABLE');
      let value = 17;
      const readStore = async () => value;
      const first = await cache.readValue(readStore);
      const warm = await cache.readValue(readStore);
      await mutation.writeValue(23, async next => { value = next; });
      const latest = await cache.readValue(readStore);
      const rendered = presentation.renderStatus(latest);
      const passed = first === 17 && warm === 17 && latest === 23 && typeof rendered === 'string' && rendered.includes('23');
      record('public-read-write-read', passed ? 'PASS' : 'FAIL', passed ? 'The public in-memory warm-read, acknowledged-write, latest-read and rendered-value probe passed.' : 'The public in-memory read/write/render probe failed; preserve the latest acknowledged value after a warm read.');
    } catch { record('public-read-write-read', 'ERROR', 'The public demo API could not complete its focused probe.'); }
  }
} catch { record('diagnostic-profile', 'ERROR', 'The fixed diagnostic recipe could not establish the bounded declared-path profile.'); }

const status = checks.some(check => check.status === 'ERROR') ? 'ERROR' : checks.some(check => check.status === 'FAIL') ? 'FAIL' : 'PASS';
const result = { schemaVersion: 1, kind: 'authoring-diagnostic', status, checks, limits: limit, acceptanceEligible: false };
const output = JSON.stringify(result);
process.stdout.write(Buffer.byteLength(output) <= limit.maximumOutputBytes ? output + '\n' : JSON.stringify({ schemaVersion: 1, kind: 'authoring-diagnostic', status: 'ERROR', checks: [{ name: 'diagnostic-output', status: 'ERROR', summary: 'Diagnostic output exceeded its fixed bound.' }], acceptanceEligible: false }) + '\n');
