// SPDX-License-Identifier: Apache-2.0
const validHeartbeat = value => typeof value === 'string' && /^[0-9]{10,16}$/.test(value);
class ObservationFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** One deadline bounds both observations. Dependencies are fixed by child.mjs. */
export async function observeChildHeartbeat(deps) {
  const now = deps.now ?? (() => performance.now());
  const wait = deps.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const started = now(), deadline = started + 10_000;
  // Reserve a bounded diagnostic opportunity inside the same total budget.
  const observationDeadline = deadline - 500;
  const setTimer = deps.setTimer ?? setTimeout, clearTimer = deps.clearTimer ?? clearTimeout;
  const bounded = async (action, until, code) => {
    if (now() >= until) throw new ObservationFailure(code);
    let timer;
    const expired = new Promise((_, reject) => { timer = setTimer(() => reject(new ObservationFailure(code)), Math.max(1, until - now())); });
    try {
      const value = await Promise.race([Promise.resolve().then(action), expired]);
      if (now() >= until) throw new ObservationFailure(code);
      return value;
    } finally { clearTimer(timer); }
  };
  let stage = 'SPAWN', child, pid = null;
  const checkChild = () => {
    const state = child.state();
    if (state.kind === 'SPAWN_FAILED') throw new ObservationFailure('SPAWN_FAILED');
    if (state.kind === 'EXITED') throw new ObservationFailure('CHILD_EXITED');
  };
  const observe = async previous => {
    const timeout = previous === null ? 'FIRST_HEARTBEAT_TIMEOUT' : 'CHANGED_HEARTBEAT_TIMEOUT';
    for (;;) {
      checkChild();
      if (now() >= observationDeadline) throw new ObservationFailure(timeout);
      const value = await bounded(() => deps.readHeartbeat(), observationDeadline, timeout);
      checkChild();
      if (now() >= observationDeadline) throw new ObservationFailure(timeout);
      // A truncate-and-write heartbeat can briefly be empty. It supplies no
      // observation until a complete timestamp appears.
      if (value !== null && value !== '') {
        if (!validHeartbeat(value)) throw new ObservationFailure('HEARTBEAT_INVALID');
        if (value !== previous) return value;
      }
      await bounded(() => wait(Math.min(100, Math.max(0, observationDeadline - now()))), observationDeadline, timeout);
    }
  };
  try {
    try { child = deps.spawn(); }
    catch { throw new ObservationFailure('SPAWN_FAILED'); }
    pid = Number.isInteger(child.pid) && child.pid > 0 ? child.pid : null;
    if (pid === null) throw new ObservationFailure('SPAWN_FAILED');
    stage = 'FIRST_HEARTBEAT'; const first = await observe(null);
    stage = 'CHANGED_HEARTBEAT'; const second = await observe(first);
    stage = 'RESULT_WRITE';
    await bounded(() => deps.writeResult({ schemaVersion: 1, pid, first, second }), observationDeadline, 'RESULT_WRITE_FAILED');
    if (now() >= observationDeadline) throw new ObservationFailure('RESULT_WRITE_FAILED');
    return { accepted: true };
  } catch (error) {
    const code = error instanceof ObservationFailure ? error.code : stage === 'RESULT_WRITE' ? 'RESULT_WRITE_FAILED' : 'STEP_FAILED';
    if (code === 'SPAWN_FAILED') stage = 'SPAWN';
    const state = child?.state();
    const diagnostic = { schemaVersion: 1, stage, code, elapsedMs: Math.min(60_000, Math.max(0, Math.floor(now() - started))), pid,
      exitCode: state?.kind === 'EXITED' && Number.isInteger(state.exitCode) && state.exitCode >= 0 && state.exitCode <= 255 ? state.exitCode : null };
    let diagnosticWritten = false;
    try {
      await bounded(() => deps.writeDiagnostic(diagnostic), Math.min(deadline, now() + 500), 'STEP_FAILED');
      diagnosticWritten = true;
    } catch { /* Parent failure remains observable even if its diagnostic cannot be retained. */ }
    return { accepted: false, diagnosticWritten };
  }
}
