// SPDX-License-Identifier: Apache-2.0
export type ChildProbeStage = 'RESERVED' | 'PARENT_DISPATCHED' | 'PARENT_EXITED' | 'RESULT_OBSERVED' | 'HEARTBEAT_OBSERVED';
export interface ChildDiagnostic {
  schemaVersion: 1; stage: 'SPAWN' | 'FIRST_HEARTBEAT' | 'CHANGED_HEARTBEAT' | 'RESULT_WRITE';
  code: 'SPAWN_FAILED' | 'CHILD_EXITED' | 'FIRST_HEARTBEAT_TIMEOUT' | 'CHANGED_HEARTBEAT_TIMEOUT' | 'HEARTBEAT_INVALID' | 'RESULT_WRITE_FAILED' | 'STEP_FAILED';
  elapsedMs: number; pid: number | null; exitCode: number | null;
}
export interface ChildProgress {
  stage: ChildProbeStage; observedAt: string; parentPid?: number; parentExitCode?: number;
  childDiagnosticStatus?: 'VALID' | 'UNOBSERVED' | 'INVALID'; childDiagnostic?: ChildDiagnostic;
  failureCode?: 'PARENT_COMPLETION_UNOBSERVED' | 'PARENT_NONZERO' | 'RESULT_INVALID' | 'CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT' | 'CHILD_PROBE_STEP_UNKNOWN';
}
interface ChildDependencies {
  exec(argv: string[], options: { stdout: 'ignore'; stderr: 'ignore'; signal: AbortSignal }): Promise<{ pid: number; exitCode: Promise<number> }>;
  readFile(path: string): Promise<Response>;
  record(progress: ChildProgress): Promise<void>;
  wait?(milliseconds: number): Promise<void>;
  now?(): number;
  parentTimeout?: number;
  postExitTimeout?: number;
}
class ChildProbeError extends Error {
  constructor(readonly code: NonNullable<ChildProgress['failureCode']>) { super(code); }
}
async function boundedText(response: Response, maximum: number): Promise<string> {
  if (!response.body) throw new ChildProbeError('RESULT_INVALID');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new ChildProbeError('RESULT_INVALID'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
const heartbeat = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{10,16}$/.test(value);
function diagnostic(raw: string): ChildDiagnostic {
  const value = JSON.parse(raw) as ChildDiagnostic;
  if (!value || JSON.stringify(value) !== raw || Object.keys(value).sort().join(',') !== 'code,elapsedMs,exitCode,pid,schemaVersion,stage' || value.schemaVersion !== 1 ||
      !['SPAWN', 'FIRST_HEARTBEAT', 'CHANGED_HEARTBEAT', 'RESULT_WRITE'].includes(value.stage) ||
      !['SPAWN_FAILED', 'CHILD_EXITED', 'FIRST_HEARTBEAT_TIMEOUT', 'CHANGED_HEARTBEAT_TIMEOUT', 'HEARTBEAT_INVALID', 'RESULT_WRITE_FAILED', 'STEP_FAILED'].includes(value.code) ||
      !Number.isInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 60_000 ||
      (value.pid !== null && (!Number.isInteger(value.pid) || value.pid <= 0)) ||
      (value.exitCode !== null && (!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)) ||
      (value.code === 'SPAWN_FAILED' && value.stage !== 'SPAWN') ||
      (value.code === 'FIRST_HEARTBEAT_TIMEOUT' && value.stage !== 'FIRST_HEARTBEAT') ||
      (value.code === 'CHANGED_HEARTBEAT_TIMEOUT' && value.stage !== 'CHANGED_HEARTBEAT') ||
      (value.code === 'RESULT_WRITE_FAILED' && value.stage !== 'RESULT_WRITE') ||
      (['CHILD_EXITED', 'HEARTBEAT_INVALID'].includes(value.code) && !['FIRST_HEARTBEAT', 'CHANGED_HEARTBEAT'].includes(value.stage))) throw new Error('INVALID_CHILD_DIAGNOSTIC');
  return value;
}

/** Only the exec parent's exit is awaited. Native output() waits descendants. */
export async function observeDetachedChild(deps: ChildDependencies): Promise<{ pid: number; heartbeat: string }> {
  const now = deps.now ?? Date.now; const wait = deps.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let progress: ChildProgress = { stage: 'RESERVED', observedAt: new Date(now()).toISOString() };
  const update = async (stage: ChildProbeStage, fields: Partial<ChildProgress> = {}) => {
    progress = { ...progress, ...fields, stage, observedAt: new Date(now()).toISOString() }; await deps.record(progress);
  };
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  let observationDeadline: number | undefined, expiredAlready = false, finished = false;
  try {
    await update('RESERVED');
    let rejectExpired: (error: ChildProbeError) => void;
    const expired = new Promise<never>((_, reject) => { rejectExpired = reject; timer = setTimeout(() => { expiredAlready = true; controller.abort(); reject(new ChildProbeError('PARENT_COMPLETION_UNOBSERVED')); }, deps.parentTimeout ?? 15_000); });
    const armPostExit = () => {
      clearTimeout(timer); timer = undefined;
      if (finished || expiredAlready || observationDeadline !== undefined) return;
      const remaining = Math.min(5_000, deps.postExitTimeout ?? 5_000);
      observationDeadline = now() + remaining;
      // This timer rejects observation only. An exited parent is never signalled.
      timer = setTimeout(() => { expiredAlready = true; rejectExpired(new ChildProbeError('CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT')); }, remaining);
    };
    const bounded = async <T>(action: () => Promise<T>): Promise<T> => {
      if (expiredAlready || (observationDeadline !== undefined && now() >= observationDeadline)) throw new ChildProbeError('CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT');
      const value = await Promise.race([Promise.resolve().then(action), expired]);
      if (expiredAlready || (observationDeadline !== undefined && now() >= observationDeadline)) throw new ChildProbeError('CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT');
      return value;
    };
    const parent = await bounded(() => deps.exec(['node', '/opt/preflight/child.mjs'], { stdout: 'ignore', stderr: 'ignore', signal: controller.signal }));
    // Native API forbids signalling an exited parent. Storage may yield long
    // after that exit, so disarm the signal before awaiting progress retention.
    void parent.exitCode.then(armPostExit, armPostExit);
    await bounded(() => update('PARENT_DISPATCHED', { parentPid: parent.pid }));
    const exitCode = await bounded(() => parent.exitCode);
    await bounded(() => update('PARENT_EXITED', { parentExitCode: exitCode }));
    if (exitCode !== 0) {
      // Observing a fixed file after the parent has exited is read-only. The
      // dispatched child is never retried, including when this read fails.
      let fields: Partial<ChildProgress> = { childDiagnosticStatus: 'UNOBSERVED' };
      try {
        const response = await bounded(() => deps.readFile('/workspace/child-diagnostic.json'));
        if (response.ok) {
          try { fields = { childDiagnosticStatus: 'VALID', childDiagnostic: diagnostic(await bounded(() => boundedText(response, 1024))) }; }
          catch { fields = { childDiagnosticStatus: 'INVALID' }; }
        }
      } catch { /* No file-read acknowledgment is not a child absence claim. */ }
      await bounded(() => update('PARENT_EXITED', fields));
      throw new ChildProbeError('PARENT_NONZERO');
    }
    let result: Record<string, unknown>;
    try { result = JSON.parse(await bounded(() => boundedTextFromFile('/workspace/child-result.json', 1024))) as Record<string, unknown>; }
    catch { throw new ChildProbeError('RESULT_INVALID'); }
    if (!result || Object.keys(result).sort().join(',') !== 'first,pid,schemaVersion,second' || result.schemaVersion !== 1 || !Number.isInteger(result.pid) || Number(result.pid) <= 0 || !heartbeat(result.first) || !heartbeat(result.second) || result.first === result.second) throw new ChildProbeError('RESULT_INVALID');
    await bounded(() => update('RESULT_OBSERVED'));
    const first = await bounded(() => boundedTextFromFile('/workspace/heartbeat.txt', 64));
    if (!heartbeat(first)) throw new ChildProbeError('CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT');
    for (;;) {
      if (observationDeadline === undefined) throw new ChildProbeError('CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT');
      await bounded(() => wait(Math.min(100, Math.max(0, observationDeadline! - now()))));
      const second = await bounded(() => boundedTextFromFile('/workspace/heartbeat.txt', 64));
      if (!heartbeat(second)) throw new ChildProbeError('CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT');
      if (first !== second) {
        await bounded(() => update('HEARTBEAT_OBSERVED'));
        if (expiredAlready || now() >= observationDeadline) throw new ChildProbeError('CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT');
        return { pid: Number(result.pid), heartbeat: second };
      }
    }
  } catch (error) {
    const failureCode = progress.parentExitCode !== undefined && progress.parentExitCode !== 0 ? 'PARENT_NONZERO' : controller.signal.aborted ? 'PARENT_COMPLETION_UNOBSERVED' : error instanceof ChildProbeError ? error.code : 'CHILD_PROBE_STEP_UNKNOWN';
    let retentionTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(() => deps.record({ ...progress, observedAt: new Date(now()).toISOString(), failureCode })), new Promise<void>(resolve => { retentionTimer = setTimeout(resolve, 500); })]);
    } catch { /* Failure retention is best effort; pending I/O is not cancelled. */ }
    finally { clearTimeout(retentionTimer); }
    if (failureCode === 'PARENT_NONZERO') throw new ChildProbeError('PARENT_NONZERO');
    throw error;
  } finally { finished = true; clearTimeout(timer); }
  async function boundedTextFromFile(path: string, maximum: number) { return boundedText(await deps.readFile(path), maximum); }
}
