#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Node 22+, no dependencies. This credential authorizes project discussion and pinned dependencies only.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const kinds = ['message', 'instruction', 'question', 'handoff', 'result'];
export const AGENT_CAPABILITIES = Object.freeze(['discussion:read', 'discussion:post', 'dependency:weft:read']);
export const WEFT_DEPENDENCY = Object.freeze({
  schema: 'confidence.pinned-dependency.v1', name: 'weft',
  repository: 'https://d6f63b7e2306adea17b338d4b6b4c739.artifacts.cloudflare.net/git/weft/weft.git',
  repositoryId: 'g5r2hnjuyz0cd3j0', ref: 'refs/tags/confidence-weft-b1c5521',
  commit: 'b1c5521bf28a0144203c55b3f056885dce3535ff', tree: '95865f40a45e6bb3f68eabe88766e593c8eb8959',
  bundle: Object.freeze({ format: 'git-bundle', sha256: '8174e542276c92ba6059fe3a02c0d61897757ec147d0e0481f026f3f4e7fa673', bytes: 756862, selfContained: true }),
});

export function parseConnection(value) {
  const fields = ['schemaVersion', 'origin', 'projectId', 'projectIncarnation', 'connectionId', 'token'];
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !fields.includes(key)) || value.schemaVersion !== 1) throw new Error('Invalid scoped connection file.');
  let origin;
  try { origin = new URL(value.origin); } catch { throw new Error('Invalid connection origin.'); }
  if (origin.protocol !== 'https:' || origin.origin !== value.origin || origin.username || origin.password) throw new Error('Connection origin must be a canonical HTTPS origin.');
  if (![value.projectId, value.projectIncarnation, value.connectionId].every(item => typeof item === 'string' && identifier.test(item))) throw new Error('Invalid connection scope.');
  if (typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || Buffer.from(value.token, 'base64url').toString('base64url') !== value.token || Buffer.from(value.token, 'base64url').length !== 32) throw new Error('Invalid scoped connection token.');
  return Object.freeze({ ...value });
}

export async function readConnection(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error('Connection must be a bounded regular file.');
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) throw new Error('Connection file must belong to you and be private: chmod 600 CONNECTION.json');
    let parsed;
    try { parsed = JSON.parse(await file.readFile('utf8')); } catch { throw new Error('Connection file is not valid JSON.'); }
    return parseConnection(parsed);
  } finally { await file.close(); }
}

export function validateDependency(value) {
  if (!value || ['schema', 'name', 'repository', 'repositoryId', 'ref', 'commit', 'tree'].some(key => value[key] !== WEFT_DEPENDENCY[key]) || ['format', 'sha256', 'bytes', 'selfContained'].some(key => value.bundle?.[key] !== WEFT_DEPENDENCY.bundle[key])) throw new Error('The service dependency does not match the qualified Weft pin.');
  return WEFT_DEPENDENCY;
}

async function readBounded(response, maximum) {
  const reader = response.body?.getReader(); const chunks = []; let size = 0;
  try {
    while (reader) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > maximum) { await reader.cancel(); throw new Error('Response exceeded its byte bound.'); }
      chunks.push(next.value);
    }
  } finally { reader?.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export function createAgentClient(input, fetcher = fetch) {
  const connection = parseConnection(input);
  const prefix = `${connection.origin}/api/projects/${connection.projectId}/agent`;
  const send = async (suffix, body, binary = false) => {
    // The caller never supplies a URL. Redirects cannot forward the scoped credential.
    const headers = { Authorization: `Bearer ${connection.token}`, 'x-confidence-connection': connection.connectionId, 'if-platform-incarnation': connection.projectIncarnation };
    if (body) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetcher(`${prefix}${suffix}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
      if (response.redirected || !response.ok) {
        // Cleanup must not delay refusal when a transport's cancellation stalls.
        try { void response.body?.cancel().catch(() => {}); } catch {}
        throw new Error(response.redirected ? 'Redirects are forbidden.' : `HTTP ${response.status}`);
      }
      const bytes = await readBounded(response, binary ? WEFT_DEPENDENCY.bundle.bytes : 1024 * 1024);
      return binary ? bytes : JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      // Never echo server bodies, request headers, or arbitrary transport exceptions.
      throw new Error(/^HTTP \d{3}$/.test(error?.message ?? '') ? `Agent request rejected (${error.message}).` : 'Agent response was not confirmed. Retry with the same request ID and exact input.');
    }
  };
  return {
    async read(after = '0') {
      if (!/^(0|[1-9][0-9]{0,18})$/.test(after)) throw new Error('Invalid discussion cursor.');
      const page = await send(`/messages?after=${after}`);
      if (page?.scope?.projectId !== connection.projectId || page?.scope?.projectIncarnation !== connection.projectIncarnation) throw new Error('The discussion response belongs to a different project or incarnation.');
      return page;
    },
    async post(message) {
      if (!identifier.test(message.requestId ?? '') || !kinds.includes(message.kind) || typeof message.text !== 'string' || !message.text.trim() || Buffer.byteLength(message.text) > 8192) throw new Error('Post requires a stable request ID, supported kind, and nonempty text of at most 8 KiB.');
      return send('/messages', { requestId: message.requestId, kind: message.kind, text: message.text });
    },
    async fetchWeft(destination) {
      const dependency = validateDependency(await send('/dependencies/weft'));
      const bytes = await send('/dependencies/weft/bundle', undefined, true);
      if (bytes.length !== dependency.bundle.bytes || createHash('sha256').update(bytes).digest('hex') !== dependency.bundle.sha256) throw new Error('Downloaded bundle identity mismatch.');
      return checkoutBundle(bytes, destination, dependency);
    },
  };
}

export function isolatedGitEnvironment(hooks, inherited = process.env) {
  return { ...Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_TEMPLATE_DIR: hooks };
}

async function checkoutBundle(bytes, destination, dependency) {
  const target = resolve(destination);
  const temporary = await mkdtemp(join(dirname(target), '.confidence-weft-'));
  const bundle = join(temporary, 'weft.bundle'); const hooks = join(temporary, 'empty-hooks');
  try {
    await writeFile(bundle, bytes, { flag: 'wx', mode: 0o600 });
    await mkdir(hooks);
    // Exclude global/system filters, hooks and templates; never run source tools while acquiring it.
    const env = isolatedGitEnvironment(hooks);
    const git = async args => (await exec('git', ['-c', `core.hooksPath=${hooks}`, ...args], { env, timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout.trim();
    // mkdir without recursive refuses every existing destination, including an empty checkout.
    await mkdir(target);
    await git(['clone', '--no-checkout', '--', bundle, target]);
    const commit = await git(['-C', target, 'rev-parse', `${dependency.ref}^{commit}`]);
    const tree = await git(['-C', target, 'rev-parse', `${dependency.commit}^{tree}`]);
    if (commit !== dependency.commit || tree !== dependency.tree) throw new Error('Git commit/tree identity mismatch.');
    await git(['-C', target, 'fsck', '--full', '--strict']);
    await git(['-C', target, 'checkout', '--detach', dependency.commit]);
    await git(['-C', target, 'remote', 'remove', 'origin']);
    return { destination: target, commit, tree, sha256: dependency.bundle.sha256, source: dependency.repository, ref: dependency.ref };
  } catch {
    throw new Error('Weft checkout was not verified. Any newly created destination is retained for inspection; existing directories are never replaced.');
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv.shift(); const options = {};
  while (argv.length) {
    const key = argv.shift(); const value = argv.shift();
    if (!['--connection', '--after', '--request-id', '--kind', '--text-file', '--destination'].includes(key) || !value || Object.hasOwn(options, key)) throw new Error('Unknown, duplicate, or incomplete option.');
    options[key] = value;
  }
  if (!options['--connection'] || !['connect', 'read', 'post', 'fetch-weft'].includes(command)) throw new Error('Usage: node scripts/confidence-agent.mjs connect|read|post|fetch-weft --connection PRIVATE.json [--after CURSOR] [--request-id ID --kind message --text-file MESSAGE.txt] [--destination NEW_DIRECTORY]');
  const connection = await readConnection(options['--connection']); const client = createAgentClient(connection);
  let result;
  if (command === 'connect') { await client.read(); result = { connected: true, origin: connection.origin, projectId: connection.projectId, connectionId: connection.connectionId, capabilities: AGENT_CAPABILITIES }; }
  else if (command === 'read') result = await client.read(options['--after']);
  else if (command === 'post') {
    if (!options['--text-file']) throw new Error('Use --text-file and retain --request-id for retries.');
    const file = await open(options['--text-file'], 'r');
    let text; try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 8192) throw new Error('Message file is too large or not regular.'); text = await file.readFile('utf8'); } finally { await file.close(); }
    result = await client.post({ requestId: options['--request-id'], kind: options['--kind'] ?? 'message', text });
  } else { if (!options['--destination']) throw new Error('Use --destination with a new directory.'); result = await client.fetchWeft(options['--destination']); }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
