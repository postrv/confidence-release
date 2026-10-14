// SPDX-License-Identifier: Apache-2.0
// Optional authoring advice. The host owns file application and protected checks.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const INTERLINKED_PREVIEW_LIMITS = Object.freeze({ paths: 16, fileBytes: 1024 * 1024, inputBytes: 4 * 1024 * 1024,
  stdoutBytes: 128 * 1024, stderrBytes: 16 * 1024, failures: 128, timeoutMs: 15_000, maximumTimeoutMs: 30_000, cleanupMs: 2_000, feedbackBytes: 4096 });
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const pathAllowed = path => typeof path === 'string' && path.length <= 240 && /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path)
  && !path.split('/').some(part => part === '.' || part === '..' || part.toLowerCase() === '.git');
const cut = (text, bytes) => {
  const raw = Buffer.from(text); if (raw.length <= bytes) return text;
  let end = bytes - 3;
  while (end > 0 && (raw[end] & 0xc0) === 0x80) end--;
  return raw.subarray(0, end).toString('utf8') + '…';
};
// These sentinels are part of the pinned CLI's output contract. Ordinary
// compiler messages may mention a symbol/module named "unavailable".
const unavailableFinding = row => row.tool === 'tsc' && row.code === 'tsc-overlay-unavailable'
  || row.tool === 'biome' && row.code === 'biome-overlay-unavailable'
  || row.tool === 'pre_block' && row.code === 'self_import' && row.line === 0 && row.severity === 'warning'
    && row.message.startsWith('[interlinked:self_import] NOT MEASURED for ');

async function snapshot(cwd, paths) {
  const entries = [];
  for (const path of paths) {
    let current = cwd, missing = false;
    for (const part of path.split('/')) {
      current = join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('SOURCE_SYMLINK_UNSUPPORTED'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; missing = true; break; }
    }
    if (missing) { entries.push({ path, digest: null }); continue; }
    const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw new Error('SOURCE_NOT_REGULAR');
      const buffer = Buffer.alloc(INTERLINKED_PREVIEW_LIMITS.fileBytes + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > INTERLINKED_PREVIEW_LIMITS.fileBytes) throw new Error('SOURCE_SIZE_LIMIT');
      entries.push({ path, digest: hash(buffer.subarray(0, bytesRead)) });
    } finally { await file.close(); }
  }
  return { entries, digest: hash(JSON.stringify(entries)), scope: 'proposed-paths-only' };
}

// JSON.parse alone accepts duplicate keys. Reject them before interpreting a verdict.
function strictJson(text) {
  const tokens = /\s+|"(?:\\.|[^"\\])*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,]/gy;
  const stack = []; let match, end = 0;
  while ((match = tokens.exec(text)) !== null) {
    end = tokens.lastIndex; const token = match[0]; if (/^\s/.test(token)) continue;
    const top = stack.at(-1);
    if (token === '{' || token === '[') { stack.push({ object: token === '{', key: true, seen: new Set() }); if (stack.length > 12) throw new Error('OUTPUT_DEPTH_LIMIT'); }
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') { if (top?.object) top.key = true; }
    else if (token === ':') { if (top?.object) top.key = false; }
    else if (top?.object && top.key && token.startsWith('"')) { const key = JSON.parse(token); if (top.seen.has(key)) throw new Error('OUTPUT_DUPLICATE_KEY'); top.seen.add(key); }
  }
  if (end !== text.length) throw new Error('OUTPUT_JSON_INVALID');
  return JSON.parse(text);
}

function parseResult(stdout, exitCode, cwd, paths) {
  const value = strictJson(stdout);
  if (!object(value) || value.preview !== true || typeof value.ok !== 'boolean') throw new Error('OUTPUT_SHAPE_INVALID');
  if (Object.hasOwn(value, 'error')) {
    if (!keys(value, ['ok', 'preview', 'error']) || value.ok || exitCode !== 2 || typeof value.error !== 'string') throw new Error('OUTPUT_SHAPE_INVALID');
    return { status: 'ERROR', reason: cut(value.error, 1024), failures: [], cliElapsedMs: null };
  }
  if (!keys(value, ['ok', 'preview', 'elapsedMs', 'failures']) || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > Number.MAX_SAFE_INTEGER
    || !Array.isArray(value.failures) || value.failures.length > INTERLINKED_PREVIEW_LIMITS.failures) throw new Error('OUTPUT_SHAPE_INVALID');
  const failures = value.failures.map(row => {
    if (!object(row) || !keys(row, ['path', 'tool', 'code', 'line', 'column', 'message', 'severity', 'hint'])
      || typeof row.path !== 'string' || !['pre_block', 'biome', 'tsc', 'pre_warn'].includes(row.tool)
      || typeof row.code !== 'string' || row.code.length > 160 || !Number.isSafeInteger(row.line) || row.line < 0
      || Object.hasOwn(row, 'column') && (!Number.isSafeInteger(row.column) || row.column < 0)
      || typeof row.message !== 'string' || row.message.length > 16_384 || !['error', 'warning'].includes(row.severity)
      || Object.hasOwn(row, 'hint') && (typeof row.hint !== 'string' || row.hint.length > 16_384)) throw new Error('OUTPUT_FINDING_INVALID');
    const path = isAbsolute(row.path) ? relative(cwd, row.path).split(sep).join('/') : row.path;
    if (!paths.includes(path)) throw new Error('OUTPUT_PATH_OUTSIDE_PROPOSAL');
    return { ...row, path };
  });
  const hasErrors = failures.some(row => row.severity === 'error');
  if (value.ok === hasErrors || exitCode !== (hasErrors ? 1 : 0)) throw new Error('OUTPUT_VERDICT_MISMATCH');
  const unavailable = failures.some(unavailableFinding);
  return { status: unavailable ? 'UNAVAILABLE' : hasErrors ? 'FINDINGS' : 'NO_BLOCKING_FINDINGS',
    reason: unavailable ? 'At least one analyzer could not establish a result.' : hasErrors ? 'The proposed changes introduce blocking local findings.' : 'The CLI reported no blocking findings; complete checker coverage is not reported.', failures, cliElapsedMs: Math.round(value.elapsedMs) };
}

async function invoke(nodePath, cliPath, cwd, input, timeoutMs, abortSignal, onLifecycle, homePath, temporaryPath) {
  let registration = Promise.resolve();
  const result = await new Promise(resolveRun => {
    let child, finished = false, closed = false, cleanupStarted = false, groupAbsent = false, reason = null, exitCode = null, signal = null, timeout;
    const chunks = { stdout: [], stderr: [] }, lengths = { stdout: 0, stderr: 0 };
    const env = { PATH: `${dirname(nodePath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`, NO_COLOR: '1', CI: '1',
      npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false' };
    for (const key of ['HOME', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
    if (homePath !== undefined) env.HOME = homePath;
    if (temporaryPath !== undefined) env.TMPDIR = temporaryPath;
    const finish = () => {
      if (finished) return; finished = true; clearTimeout(timeout); abortSignal?.removeEventListener('abort', abort);
      const raw = { stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr) };
      let stdout;
      try { stdout = new TextDecoder('utf-8', { fatal: true }).decode(raw.stdout); }
      catch { reason ??= 'CLI_OUTPUT_ENCODING'; stdout = cut(raw.stdout.toString('utf8'), INTERLINKED_PREVIEW_LIMITS.stdoutBytes); }
      resolveRun({ pid: child?.pid, exitCode, signal, terminationObserved: closed && groupAbsent, reason,
        stdout, stderr: cut(raw.stderr.toString('utf8'), INTERLINKED_PREVIEW_LIMITS.stderrBytes),
        stdoutDigest: hash(raw.stdout), stderrDigest: hash(raw.stderr), stdoutBytes: lengths.stdout, stderrBytes: lengths.stderr });
    };
    const alive = () => {
      if (!child?.pid) return false;
      try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
    };
    const kill = selected => { if (!child?.pid) return; try { process.kill(-child.pid, selected); } catch { /* Absence is checked separately; failed signalling cannot establish termination. */ } };
    const stop = async cause => {
      reason ??= cause;
      if (cleanupStarted) return; cleanupStarted = true; clearTimeout(timeout);
      const started = performance.now(); let hardKilled = false;
      // A clean leader exit can leave descendants whose stdio was detached.
      // Always stop and observe the group, not just the leader's close event.
      kill('SIGTERM');
      while (performance.now() - started < INTERLINKED_PREVIEW_LIMITS.cleanupMs) {
        groupAbsent = !alive();
        if (closed && groupAbsent) { finish(); return; }
        if (!hardKilled && performance.now() - started >= 250) { kill('SIGKILL'); hardKilled = true; }
        await new Promise(accept => setTimeout(accept, 20));
      }
      kill('SIGKILL'); groupAbsent = !alive();
      child?.stdout?.destroy(); child?.stderr?.destroy(); child?.stdin?.destroy(); finish();
    };
    const abort = () => { void stop('PREVIEW_ABORTED'); };
    if (abortSignal?.aborted) { reason = 'PREVIEW_ABORTED'; closed = true; groupAbsent = true; finish(); return; }
    try { child = spawn(nodePath, [cliPath, 'verify-changeset', '--stdin', '--json'], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reason = 'CLI_SPAWN_FAILED'; closed = true; groupAbsent = true; finish(); return; }
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      const maximum = INTERLINKED_PREVIEW_LIMITS[stream + 'Bytes'], available = Math.max(0, maximum - lengths[stream]);
      if (available) chunks[stream].push(chunk.subarray(0, available)); lengths[stream] += chunk.length;
      if (lengths[stream] > maximum) stop('CLI_OUTPUT_LIMIT');
    });
    child.once('error', () => { void stop('CLI_SPAWN_FAILED'); });
    child.once('close', (code, observedSignal) => { closed = true; exitCode = code; signal = observedSignal;
      void stop(null); });
    child.stdin.on('error', () => { /* Early EOF is classified by the exit/output contract. */ });
    timeout = setTimeout(() => { void stop('CLI_TIMEOUT'); }, timeoutMs);
    abortSignal?.addEventListener('abort', abort, { once: true });
    registration = Promise.resolve().then(() => onLifecycle?.({ phase: 'SPAWNED', pid: child.pid })).then(() => {
      if (abortSignal?.aborted) abort();
      else if (!cleanupStarted && !finished) child.stdin.end(input);
    }).catch(() => stop('PREVIEW_LIFECYCLE_FAILED'));
  });
  await registration;
  return result;
}

/** Native CLI preview only: no hook installation, dependency install or proposal writes. */
export async function runInterlinkedPreview({ cwd, files, allowedPaths, cliPath, generation = '1', nodePath = process.execPath, timeoutMs = INTERLINKED_PREVIEW_LIMITS.timeoutMs, signal, onLifecycle, homePath, temporaryPath }) {
  const startedAt = new Date().toISOString(), started = performance.now();
  const observation = { schemaVersion: 1, kind: 'interlinked-preview', producer: 'host-invoked-interlinked-cli', trustClass: 'authoring-generation-diagnostic',
    acceptanceEligible: false, generation: String(generation), status: 'ERROR', blocking: false, reason: '', startedAt, completedAt: '', elapsedMs: 0,
    coverage: { status: 'NOT_REPORTED', typescriptTargetPaths: [], typescriptExcludedPaths: [], limitations: [
      'The upstream preview reports findings, not an exhaustive per-file checker execution manifest.',
      'TypeScript overlay applies only to TS/TSX/MTS/CTS; Biome requires project configuration.',
      'No blocking findings is a local preview result, not protected acceptance or proof of correctness.',
    ] }, failures: [], cliElapsedMs: null, sourceCoherence: 'UNKNOWN', limits: INTERLINKED_PREVIEW_LIMITS };
  try {
    if (!object(files) || !Array.isArray(allowedPaths) || allowedPaths.length < 1 || allowedPaths.length > INTERLINKED_PREVIEW_LIMITS.paths
      || new Set(allowedPaths).size !== allowedPaths.length || !allowedPaths.every(pathAllowed)) throw new Error('PROPOSAL_GRANT_INVALID');
    const paths = Object.keys(files).sort();
    if (!paths.length || paths.length > INTERLINKED_PREVIEW_LIMITS.paths || paths.some(path => !pathAllowed(path) || !allowedPaths.includes(path)
      || typeof files[path] !== 'string' || Buffer.byteLength(files[path]) > INTERLINKED_PREVIEW_LIMITS.fileBytes)) throw new Error('PROPOSAL_OUTSIDE_GRANT');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > INTERLINKED_PREVIEW_LIMITS.maximumTimeoutMs
      || observation.generation.length > 128 || typeof nodePath !== 'string' || !isAbsolute(nodePath)
      || [homePath, temporaryPath].some(path => path !== undefined && (typeof path !== 'string' || !isAbsolute(path)))) throw new Error('PREVIEW_CONFIG_INVALID');
    observation.limits = { ...INTERLINKED_PREVIEW_LIMITS, timeoutMs };
    cwd = await realpath(cwd);
    observation.coverage.typescriptTargetPaths = paths.filter(path => /\.(tsx?|mts|cts)$/.test(path));
    observation.coverage.typescriptExcludedPaths = paths.filter(path => !/\.(tsx?|mts|cts)$/.test(path));
    if (!cliPath) { observation.status = 'UNAVAILABLE'; observation.reason = 'INTERLINKED_CLI_NOT_CONFIGURED'; return observation; }
    if (typeof cliPath !== 'string' || !isAbsolute(cliPath)) throw new Error('CLI_PATH_MUST_BE_ABSOLUTE');
    let entry;
    try { const info = await lstat(cliPath); if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error(); entry = await readFile(cliPath); }
    catch { observation.status = 'UNAVAILABLE'; observation.reason = 'INTERLINKED_CLI_UNAVAILABLE'; return observation; }
    observation.identity = { cliPath, cliEntryDigest: hash(entry), nodeVersion: nodePath === process.execPath ? process.version : 'externally-selected', nodePath, adapter: 'confidence-interlinked-preview-v1' };
    const input = JSON.stringify({ version: 1, changes: paths.map(path => ({ path: resolve(cwd, path), content: files[path] })) });
    if (Buffer.byteLength(input) > INTERLINKED_PREVIEW_LIMITS.inputBytes) throw new Error('PROPOSAL_INPUT_LIMIT');
    observation.inputDigest = hash(input); observation.before = await snapshot(cwd, paths);
    if (signal?.aborted) throw new Error('PREVIEW_ABORTED');
    await onLifecycle?.({ phase: 'PREPARING' });
    const processResult = await invoke(nodePath, cliPath, cwd, input, timeoutMs, signal, onLifecycle, homePath, temporaryPath);
    observation.process = { exitCode: processResult.exitCode, signal: processResult.signal, terminationObserved: processResult.terminationObserved,
        stdoutBytes: processResult.stdoutBytes, stderrBytes: processResult.stderrBytes };
    await onLifecycle?.({ phase: 'SETTLED', pid: processResult.pid, terminationObserved: processResult.terminationObserved });
    // Raw capture is bounded and retained; the feedback helper never forwards it.
    observation.capture = { stdout: processResult.stdout, stderr: processResult.stderr, stdoutDigest: processResult.stdoutDigest, stderrDigest: processResult.stderrDigest };
    observation.after = await snapshot(cwd, paths);
    observation.sourceCoherence = observation.before.digest === observation.after.digest ? 'COHERENT' : 'CHANGED';
    if (processResult.reason) throw new Error(processResult.reason);
    if (!processResult.terminationObserved) throw new Error('CLI_TERMINATION_UNCONFIRMED');
    if (observation.sourceCoherence !== 'COHERENT') throw new Error('SOURCE_CHANGED_DURING_PREVIEW');
    Object.assign(observation, parseResult(processResult.stdout, processResult.exitCode, cwd, paths));
    observation.blocking = observation.failures.some(row => row.severity === 'error' && !unavailableFinding(row));
  } catch (error) { observation.status = 'ERROR'; observation.reason = cut(error instanceof Error ? error.message : 'PREVIEW_ERROR', 1024); }
  finally { observation.completedAt = new Date().toISOString(); observation.elapsedMs = Math.round(performance.now() - started); }
  return observation;
}

/** Keep analyzer output out of the model prompt except for bounded, relevant advice. */
export function interlinkedPreviewFeedback(observation) {
  const feedback = { kind: 'interlinked-preview', status: observation.status, acceptanceEligible: false, reason: cut(observation.reason ?? '', 512),
    coverage: 'The preview does not establish complete checker coverage.', failures: [], omittedFailures: observation.failures?.length ?? 0 };
  for (const row of observation.failures ?? []) {
    const item = { path: row.path, code: row.code, line: row.line, severity: row.severity, message: cut(row.message, 512), ...(row.hint ? { hint: cut(row.hint, 256) } : {}) };
    feedback.failures.push(item); feedback.omittedFailures--;
    if (Buffer.byteLength(JSON.stringify(feedback)) > INTERLINKED_PREVIEW_LIMITS.feedbackBytes) { feedback.failures.pop(); feedback.omittedFailures++; break; }
  }
  return feedback;
}

export const interlinkedFeedback = interlinkedPreviewFeedback;
