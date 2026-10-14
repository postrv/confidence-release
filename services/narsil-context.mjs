// SPDX-License-Identifier: Apache-2.0
// Host-only advisory selector. It never executes source, exposes MCP to a model,
// or supplies acceptance evidence. The analyzer only supplies bounded locations;
// all returned text is sliced from the independently verified input bytes.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MiB = 1024 * 1024, SELECTOR = 'narsil-context-v1';
const DEFAULT_LIMITS = Object.freeze({ deadlineMs: 8000, maxQueries: 12, maxAnalyzerBytes: MiB, maxOutputBytes: 32768, maxExcerptBytes: 16384, maxExcerpts: 12, maxLinesPerExcerpt: 80 });
const FLAGS = ['--preset', 'full', '--call-graph', '--no-cache'];
const READINESS = Object.freeze({ maxQueries: 128, pollMs: 50 });
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownKeys = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const fail = code => { throw new Error(code); };
const hashShape = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const pause = ms => new Promise(res => setTimeout(res, ms));
// Same individual-path profile as the authority kernel's valid_path grant check.
const portablePath = value => typeof value === 'string' && value.length > 0 && value.length <= 240
  && !/[^\x20-\x7e]|[\\<>:"|?*]/.test(value)
  && value.split('/').every(part => part.length > 0 && part.length <= 80 && !['.', '..'].includes(part)
    && part.toLowerCase() !== '.git' && !/[ .]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));

function normalizeConfig(config = {}) {
  if (!ownKeys(config, ['enabled', 'includeSmallProjects', 'binaryPath', 'expectedVersion', 'expectedBinaryDigest', 'limits'])) fail('INVALID_CONFIG');
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean' || config.includeSmallProjects !== undefined && typeof config.includeSmallProjects !== 'boolean') fail('INVALID_CONFIG');
  const expectedVersion = config.expectedVersion ?? '1.7.2';
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion) || config.binaryPath !== undefined && (typeof config.binaryPath !== 'string' || !isAbsolute(config.binaryPath)) || config.expectedBinaryDigest !== undefined && !hashShape(config.expectedBinaryDigest)) fail('INVALID_CONFIG');
  if (config.limits !== undefined && !ownKeys(config.limits, Object.keys(DEFAULT_LIMITS))) fail('INVALID_CONFIG');
  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  for (const [name, value] of Object.entries(limits)) {
    const maximum = { deadlineMs: 30000, maxQueries: 32, maxAnalyzerBytes: 4 * MiB }[name];
    if (!Number.isSafeInteger(value) || value < 1 || (maximum ? value > maximum : value !== DEFAULT_LIMITS[name])) fail('INVALID_CONFIG');
  }
  const normalized = { enabled: config.enabled ?? false, includeSmallProjects: config.includeSmallProjects ?? false, expectedVersion, expectedBinaryDigest: config.expectedBinaryDigest ?? null, limits, readiness: READINESS, flags: FLAGS, selectorVersion: SELECTOR };
  return { ...normalized, binaryPath: config.binaryPath, configDigest: hash(canonical(normalized)) };
}

function verifySource(input) {
  if (!record(input) || !/^[a-f0-9]{40}$/.test(input.sourceCommit) || !hashShape(input.sourceManifestDigest)) fail('INVALID_SOURCE_IDENTITY');
  const manifest = input.manifest;
  if (!ownKeys(manifest, ['schemaVersion', 'pathProfile', 'entries']) || manifest.schemaVersion !== 1 || manifest.pathProfile !== 'portable-ascii-v1' || !Array.isArray(manifest.entries) || manifest.entries.length > 2048) fail('INVALID_SOURCE_MANIFEST');
  const files = new Map(), folds = new Map(); let sourceBytes = 0, pathBytes = 0, previous = '';
  if (!record(input.filesBase64) || Object.keys(input.filesBase64).length !== manifest.entries.length) fail('INVALID_SOURCE_INVENTORY');
  for (const entry of manifest.entries) {
    if (!ownKeys(entry, ['path', 'mode', 'bytes', 'digest']) || typeof entry.path !== 'string' || !entry.path || entry.path.length > 240 || /[^\x20-\x7e]|[\\<>:"|?*]/.test(entry.path) || !['100644', '100755'].includes(entry.mode) || typeof entry.bytes !== 'string' || !/^(0|[1-9][0-9]*)$/.test(entry.bytes) || !hashShape(entry.digest)) fail('INVALID_SOURCE_ENTRY');
    const parts = entry.path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i], prefix = parts.slice(0, i + 1).join('/'), folded = prefix.toLowerCase();
      if (!part || part.length > 80 || ['.', '..'].includes(part) || part.toLowerCase() === '.git' || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || folds.has(folded) && folds.get(folded) !== prefix || files.has(prefix)) fail('INVALID_SOURCE_PATH');
      folds.set(folded, prefix);
    }
    if (previous && (previous >= entry.path || entry.path.startsWith(previous + '/'))) fail('INVALID_SOURCE_ORDER');
    previous = entry.path; const size = Number(entry.bytes);
    sourceBytes += size; pathBytes += entry.path.length;
    if (!Number.isSafeInteger(size) || size > MiB || sourceBytes > 4 * MiB || pathBytes > 65536) fail('SOURCE_LIMIT');
    const encoded = Object.hasOwn(input.filesBase64, entry.path) ? input.filesBase64[entry.path] : undefined;
    if (typeof encoded !== 'string' || encoded.length !== Math.ceil(size / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('INVALID_SOURCE_BYTES');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== size || bytes.toString('base64') !== encoded || hash(bytes) !== entry.digest) fail('SOURCE_DIGEST_MISMATCH');
    files.set(entry.path, { entry, bytes });
  }
  if (hash(canonical(manifest)) !== input.sourceManifestDigest) fail('SOURCE_MANIFEST_DIGEST_MISMATCH');
  if (!Array.isArray(input.assignedPaths) || input.assignedPaths.length > 16 || !input.assignedPaths.length || new Set(input.assignedPaths).size !== input.assignedPaths.length || input.assignedPaths.some(path => !portablePath(path))) fail('INVALID_ASSIGNED_PATHS');
  return { files, sourceBytes, assignedPaths: [...input.assignedPaths].sort() };
}

function groupAlive(pid) {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function signalGroup(pid, signal) {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

/** Always address the owned process group, even after its leader exited. */
async function stopOwned(child) {
  if (!child) return;
  const pid = child.pid;
  try {
    signalGroup(pid, 'SIGTERM');
    for (let i = 0; i < 10 && groupAlive(pid); i++) await pause(10);
    if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
    for (let i = 0; i < 40 && groupAlive(pid); i++) await pause(10);
    if (groupAlive(pid)) fail('TERMINATION_UNCONFIRMED');
  } catch { fail('TERMINATION_UNCONFIRMED');
  } finally {
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
  }
}

function remaining(deadline) { const ms = deadline - Date.now(); if (ms <= 0) fail('DEADLINE_EXCEEDED'); return ms; }
function childEnv(directory) {
  // No provider credentials, loader hooks, global config, or inherited Narsil options.
  return { PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: directory, XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'), NARSIL_CONFIG_PATH: join(directory, 'config', 'absent.yaml'), LC_ALL: 'C', RUST_LOG: 'error' };
}
function consume(budget, chunk) { budget.used += chunk.length; if (budget.used > budget.max) fail('ANALYZER_OUTPUT_LIMIT'); }

async function identifyVersion(binary, options, deadline, budget) {
  let child;
  try {
    return await new Promise((res, rej) => {
      const buffers = []; let count = 0, settled = false;
      const done = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? rej(error) : res(value); };
      const timer = setTimeout(() => done(new Error('DEADLINE_EXCEEDED')), remaining(deadline));
      child = spawn(binary, ['--version'], { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', () => done(new Error('BINARY_UNAVAILABLE')));
      const read = (chunk, stdout) => {
        try { consume(budget, chunk); count += chunk.length; if (count > 8192) fail('VERSION_OUTPUT_LIMIT'); if (stdout) buffers.push(chunk); } catch (error) { done(error); }
      };
      child.stdout.on('data', chunk => read(chunk, true)); child.stderr.on('data', chunk => read(chunk, false));
      child.on('close', code => {
        if (code !== 0) return done(new Error('VERSION_UNAVAILABLE'));
        const text = Buffer.concat(buffers).toString('utf8').trim(), match = /^narsil-mcp (\d+\.\d+\.\d+)$/.exec(text);
        done(match ? undefined : new Error('VERSION_UNAVAILABLE'), match?.[1]);
      });
    });
  } finally { await stopOwned(child); }
}

class McpClient {
  constructor(binary, args, options, deadline, budget) {
    this.deadline = deadline; this.budget = budget; this.nextId = 1; this.pending = null; this.failure = null; this.buffer = ''; this.notifications = 0;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.child = spawn(binary, args, { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', () => this.reject('BINARY_UNAVAILABLE'));
    this.child.on('close', () => { if (!this.closing) this.reject('ANALYZER_EXITED'); });
    this.child.stdin.on('error', () => { if (!this.closing) this.reject('ANALYZER_EXITED'); });
    this.child.stderr.on('data', chunk => { try { consume(budget, chunk); } catch { this.reject('ANALYZER_OUTPUT_LIMIT'); } });
    this.child.stdout.on('data', chunk => {
      try {
        consume(budget, chunk); this.buffer += this.decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, boundary); this.buffer = this.buffer.slice(boundary + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (!record(message) || message.jsonrpc !== '2.0') fail('MALFORMED_OUTPUT');
          if (!Object.hasOwn(message, 'id') && typeof message.method === 'string') {
            if (++this.notifications > 64) fail('ANALYZER_OUTPUT_LIMIT');
            continue;
          }
          if (!this.pending || message.id !== this.pending.id || !Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) fail('MALFORMED_OUTPUT');
          const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.resolve(message.result);
        }
      } catch (error) { this.reject(error.message === 'ANALYZER_OUTPUT_LIMIT' ? error.message : 'MALFORMED_OUTPUT'); }
    });
  }
  reject(code) { this.failure ??= new Error(code); if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(this.failure); this.pending = null; } }
  async request(method, params) {
    if (this.failure) throw this.failure;
    if (this.pending) fail('CONCURRENT_MCP_REQUEST');
    const timeout = remaining(this.deadline), id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject, timer: setTimeout(() => this.reject('DEADLINE_EXCEEDED'), timeout) };
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method) { if (this.failure) throw this.failure; this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); }
  async tool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    if (!record(result) || result.isError || !Array.isArray(result.content) || result.content.some(item => !record(item) || item.type !== 'text' || typeof item.text !== 'string')) fail('ANALYZER_TOOL_ERROR');
    return result.content.map(item => item.text).join('\n');
  }
  async close() {
    this.closing = true;
    if (this.pending) this.reject('ANALYZER_CLOSED');
    await stopOwned(this.child);
    try { this.buffer += this.decoder.decode(); if (this.buffer.trim()) this.reject('MALFORMED_OUTPUT'); }
    catch { this.reject('MALFORMED_OUTPUT'); }
    // A malformed trailing message can arrive after the last valid reply.
    if (this.failure) throw this.failure;
  }
}

function relatedPaths(text, assigned, files) {
  const paths = new Set(); let section = '', ignored = false;
  for (const line of text.split('\n')) {
    if (line === '## Imports') section = 'imports';
    else if (line === '## Imported By') section = 'imported';
    else if (/^## /.test(line)) section = '';
    const match = /^- `([^`]+)`$/.exec(line);
    if (!match || !section) continue;
    const value = match[1];
    if (section === 'imported') { if (files.has(value)) paths.add(value); else ignored = true; }
    else if (value.startsWith('.')) {
      const base = posix.normalize(posix.join(posix.dirname(assigned), value));
      const candidates = [base, ...['.ts', '.tsx', '.js', '.mjs', '.jsx', '.rs'].map(ext => base + ext), ...['.ts', '.tsx', '.js', '.mjs', '.jsx'].map(ext => base + '/index' + ext)];
      const found = candidates.find(path => files.has(path));
      if (found) paths.add(found); else ignored = true;
    }
  }
  return { paths: [...paths].sort(), ignored };
}

function assembleExcerpts(hints, source, advisory) {
  const assigned = new Set(source.assignedPaths), linesByPath = new Map(), ranges = new Map();
  const sorted = [...hints].sort((a, b) => a.priority - b.priority || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line);
  for (const hint of sorted) {
    if (assigned.has(hint.path)) continue;
    const file = source.files.get(hint.path);
    if (!file || !Number.isSafeInteger(hint.line) || hint.line < 1) { advisory.coverage.incomplete = true; continue; }
    if (!linesByPath.has(hint.path)) {
      try { linesByPath.set(hint.path, new TextDecoder('utf-8', { fatal: true }).decode(file.bytes).split('\n')); }
      catch { linesByPath.set(hint.path, null); }
    }
    const lines = linesByPath.get(hint.path);
    if (!lines || hint.line > lines.length || hint.line > MiB) { advisory.coverage.incomplete = true; continue; }
    const startLine = Math.max(1, hint.line - 8), endLine = Math.min(lines.length, MiB, startLine + advisory.limits.maxLinesPerExcerpt - 1);
    const key = `${hint.path}:${startLine}:${endLine}`;
    if (!ranges.has(key)) ranges.set(key, { path: hint.path, fileDigest: file.entry.digest, startLine, endLine, lines, priority: hint.priority });
  }
  // Union overlapping locations before spending context bytes on any excerpt.
  const merged = [];
  for (const range of [...ranges.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.startLine - b.startLine)) {
    const last = merged.at(-1);
    if (last?.path === range.path && range.startLine <= last.endLine + 1) { last.endLine = Math.max(last.endLine, range.endLine); last.priority = Math.min(last.priority, range.priority); }
    else merged.push({ ...range });
  }
  merged.sort((a, b) => a.priority - b.priority || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.startLine - b.startLine);
  let bytes = 0;
  const slices = function* () { for (const range of merged) for (let startLine = range.startLine; startLine <= range.endLine; startLine += advisory.limits.maxLinesPerExcerpt) yield { ...range, startLine, endLine: Math.min(range.endLine, startLine + advisory.limits.maxLinesPerExcerpt - 1) }; };
  for (const range of slices()) {
    let { endLine } = range;
    if (advisory.excerpts.length >= advisory.limits.maxExcerpts) { advisory.coverage.incomplete = true; break; }
    let text = range.lines.slice(range.startLine - 1, endLine).join('\n');
    while (Buffer.byteLength(text) + bytes > advisory.limits.maxExcerptBytes && endLine > range.startLine) { endLine--; text = range.lines.slice(range.startLine - 1, endLine).join('\n'); }
    if (endLine !== range.endLine) advisory.coverage.incomplete = true;
    if (Buffer.byteLength(text) + bytes > advisory.limits.maxExcerptBytes) { advisory.coverage.incomplete = true; continue; }
    advisory.excerpts.push({ path: range.path, fileDigest: range.fileDigest, startLine: range.startLine, endLine, text, digest: hash(text) }); bytes += Buffer.byteLength(text);
  }
  while (Buffer.byteLength(canonical(advisory)) > advisory.limits.maxOutputBytes) { advisory.excerpts.pop(); advisory.coverage.incomplete = true; }
}

function recordFailure(advisory, error) {
  const allowed = ['BINARY_UNAVAILABLE', 'VERSION_UNAVAILABLE', 'BINARY_DIGEST_MISMATCH', 'VERSION_MISMATCH', 'DEADLINE_EXCEEDED', 'INDEX_NOT_READY', 'ANALYZER_OUTPUT_LIMIT', 'VERSION_OUTPUT_LIMIT', 'MALFORMED_OUTPUT', 'ANALYZER_TOOL_ERROR', 'ANALYZER_EXITED', 'TERMINATION_UNCONFIRMED'];
  const code = error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'DEADLINE_EXCEEDED' : ['ENOENT', 'EACCES'].includes(error?.code) ? 'BINARY_UNAVAILABLE' : allowed.includes(error?.message) ? error.message : 'ANALYZER_ERROR';
  advisory.status = ['BINARY_UNAVAILABLE', 'VERSION_UNAVAILABLE', 'BINARY_DIGEST_MISMATCH', 'VERSION_MISMATCH'].includes(code) ? 'UNAVAILABLE' : 'ERROR'; advisory.reason = code; advisory.excerpts = []; advisory.coverage.incomplete = true;
}

/** Input is a trusted host's full exact source map, never the mutable worktree. */
export async function buildNarsilContext(input) {
  const config = normalizeConfig(input?.config), source = verifySource(input);
  const advisory = {
    schemaVersion: 1, kind: 'source-advisory', sourceCommit: input.sourceCommit, sourceManifestDigest: input.sourceManifestDigest, selectorVersion: SELECTOR,
    acceptanceEligible: false, authorityEligible: false, status: 'SKIPPED', reason: 'DISABLED',
    analyzer: { version: null, binaryDigest: null, configDigest: config.configDigest }, limits: config.limits, excerpts: [],
    coverage: { sourceFiles: source.files.size, sourceBytes: source.sourceBytes, indexedFiles: null, assignedPaths: source.assignedPaths, queriedPaths: [], queryCount: 0, incomplete: true }
  };
  if (!config.enabled) return advisory;
  if (source.assignedPaths.some(path => !source.files.has(path))) { advisory.reason = 'NEW_ASSIGNED_PATH'; return advisory; }
  if (source.files.size <= 4 && !config.includeSmallProjects) { advisory.reason = 'SMALL_PROJECT'; return advisory; }
  if (!config.binaryPath || process.platform === 'win32') { advisory.status = 'UNAVAILABLE'; advisory.reason = 'BINARY_UNAVAILABLE'; return advisory; }
  const deadline = Date.now() + config.limits.deadlineMs, budget = { used: 0, max: config.limits.maxAnalyzerBytes };
  let directory, client;
  try {
    const binaryPath = await realpath(config.binaryPath), info = await stat(binaryPath);
    if (!info.isFile() || info.size > 128 * MiB) fail('BINARY_UNAVAILABLE');
    const binaryBytes = await readFile(binaryPath, { signal: AbortSignal.timeout(remaining(deadline)) });
    if (binaryBytes.length > 128 * MiB) fail('BINARY_UNAVAILABLE');
    advisory.analyzer.binaryDigest = hash(binaryBytes);
    if (config.expectedBinaryDigest && config.expectedBinaryDigest !== advisory.analyzer.binaryDigest) fail('BINARY_DIGEST_MISMATCH');
    directory = await mkdtemp(join(tmpdir(), 'confidence-narsil-'));
    // Execute the exact bytes hashed above, not a concurrently replaced install.
    const binary = join(directory, 'narsil-mcp');
    await writeFile(binary, binaryBytes, { mode: 0o500, flag: 'wx', signal: AbortSignal.timeout(remaining(deadline)) });
    const options = { cwd: directory, env: childEnv(directory) };
    advisory.analyzer.version = await identifyVersion(binary, options, deadline, budget);
    if (advisory.analyzer.version !== config.expectedVersion) fail('VERSION_MISMATCH');
    const snapshot = join(directory, 'source'); await mkdir(snapshot);
    for (const [path, file] of source.files) {
      remaining(deadline); await mkdir(dirname(join(snapshot, path)), { recursive: true });
      await writeFile(join(snapshot, path), file.bytes, { mode: file.entry.mode === '100755' ? 0o555 : 0o444, flag: 'wx', signal: AbortSignal.timeout(remaining(deadline)) });
    }
    client = new McpClient(binary, ['--repos', snapshot, '--index-path', join(directory, 'index'), ...FLAGS], options, deadline, budget);
    const init = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'confidence-narsil-context', version: '1' } });
    if (!record(init) || typeof init.protocolVersion !== 'string') fail('MALFORMED_OUTPUT');
    client.notify('notifications/initialized');
    for (let poll = 0; ; poll++) {
      if (poll >= READINESS.maxQueries) fail('INDEX_NOT_READY');
      const status = await client.tool('get_index_status', { repo: 'source' });
      if (/\*\*Status\*\*:.*\bComplete\b/.test(status)) {
        const count = /(?:^|\n)- Files: (\d+)(?:\r?\n|$)/.exec(status);
        const indexed = count ? Number(count[1]) : null;
        advisory.coverage.indexedFiles = Number.isSafeInteger(indexed) && indexed >= 0 && indexed <= source.files.size ? indexed : null;
        advisory.coverage.incomplete = advisory.coverage.indexedFiles !== source.files.size || status.includes('INDEX INCOMPLETE'); break;
      }
      await pause(Math.min(READINESS.pollMs, remaining(deadline)));
    }
    const hints = [], symbols = new Map();
    const query = async (name, args) => {
      if (advisory.coverage.queryCount >= config.limits.maxQueries) { advisory.coverage.incomplete = true; return null; }
      advisory.coverage.queryCount++; return client.tool(name, args);
    };
    for (const path of source.assignedPaths) {
      const text = await query('find_symbols', { repo: 'source', file_pattern: path.replace(/[\[\]]/g, char => '[' + char + ']'), exclude_tests: false });
      if (text === null) break;
      advisory.coverage.queriedPaths.push(path);
      for (const line of text.split('\n')) {
        const match = /^- \*\*([A-Za-z_$][A-Za-z0-9_$.:<>-]{0,159})\*\* \(`([^`]+):(\d+)`\)/.exec(line);
        if (!match) continue;
        if (match[2] !== path || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) < 1) { advisory.coverage.incomplete = true; continue; }
        symbols.set(match[1], true);
      }
      const dependencies = await query('get_dependencies', { repo: 'source', path, direction: 'both' });
      if (dependencies !== null) {
        const related = relatedPaths(dependencies, path, source.files); advisory.coverage.incomplete ||= related.ignored;
        for (const relatedPath of related.paths) hints.push({ path: relatedPath, line: 1, priority: 1 });
      }
    }
    for (const symbol of [...symbols.keys()].sort()) {
      const callers = await query('get_callers', { repo: 'source', function: symbol, transitive: false, max_depth: 1, exclude_tests: false });
      if (callers === null) break;
      for (const line of callers.split('\n')) {
        const match = /^- `[^`]+` at `([^`]+):(\d+)`/.exec(line);
        if (match) hints.push({ path: match[1], line: Number(match[2]), priority: 0 });
      }
    }
    if (client.failure) throw client.failure;
    remaining(deadline);
    advisory.status = 'READY'; advisory.reason = 'COMPLETE'; assembleExcerpts(hints, source, advisory);
    if (advisory.coverage.incomplete) advisory.reason = 'INCOMPLETE_COVERAGE';
    while (Buffer.byteLength(canonical(advisory)) > advisory.limits.maxOutputBytes) { advisory.excerpts.pop(); advisory.coverage.incomplete = true; advisory.reason = 'INCOMPLETE_COVERAGE'; }
  } catch (error) {
    recordFailure(advisory, error);
  } finally {
    try { if (client) await client.close(); }
    catch (error) { recordFailure(advisory, error); }
    // Never remove a snapshot while an unobserved analyzer could still read it.
    if (directory && advisory.reason !== 'TERMINATION_UNCONFIRMED') await rm(directory, { recursive: true, force: true });
  }
  return advisory;
}

async function cli() {
  const args = process.argv.slice(2); let bytes;
  if (args.length === 2 && args[0] === '--input' && isAbsolute(args[1])) {
    const info = await stat(args[1]); if (!info.isFile() || info.size > 6 * MiB) fail('INPUT_LIMIT'); bytes = await readFile(args[1]);
  } else if (!args.length) {
    const chunks = []; let count = 0;
    const timer = setTimeout(() => process.stdin.destroy(new Error('INPUT_DEADLINE')), 10000);
    try { for await (const chunk of process.stdin) { count += chunk.length; if (count > 6 * MiB) fail('INPUT_LIMIT'); chunks.push(chunk); } }
    finally { clearTimeout(timer); }
    bytes = Buffer.concat(chunks);
  } else fail('USAGE: narsil-context.mjs [--input /absolute/input.json]');
  const advisory = await buildNarsilContext(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  process.stdout.write(canonical(advisory));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch(() => { process.stderr.write('NARSIL_CONTEXT_INPUT_OR_HOST_ERROR\n'); process.exitCode = 1; });
}
