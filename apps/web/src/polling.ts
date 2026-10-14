// SPDX-License-Identifier: Apache-2.0
interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

interface IntervalClock {
  setInterval(callback: () => void, delayMs: number): number;
  clearInterval(handle: number): void;
}

/** A command's full read must follow any poll that was already in flight. */
export function createRefreshQueue(read: (force: boolean) => Promise<void>): (force?: boolean) => Promise<void> {
  let active: Promise<void> | undefined;
  let queuedForced: Promise<void> | undefined;
  const start = (force: boolean): Promise<void> => {
    const work = Promise.resolve().then(() => read(force));
    const tracked = work.finally(() => { if (active === tracked) active = undefined; });
    active = tracked;
    return tracked;
  };
  const refresh = (force = false): Promise<void> => {
    if (queuedForced) return queuedForced;
    if (!active) return start(force);
    if (!force) return active;
    const current = active;
    const startForced = () => { queuedForced = undefined; return start(true); };
    queuedForced = current.then(startForced, startForced);
    return queuedForced;
  };
  return refresh;
}

/** Keep foreground snapshots current without polling a hidden tab. */
export function startVisiblePolling(visibility: VisibilitySource, clock: IntervalClock, refresh: () => void, intervalMs = 2500): () => void {
  let interval: number | undefined;
  const pause = () => {
    if (interval !== undefined) clock.clearInterval(interval);
    interval = undefined;
  };
  const sync = () => {
    if (visibility.hidden) { pause(); return; }
    if (interval !== undefined) return;
    refresh();
    interval = clock.setInterval(() => {
      if (visibility.hidden) { pause(); return; }
      refresh();
    }, intervalMs);
  };
  visibility.addEventListener('visibilitychange', sync);
  sync();
  return () => { visibility.removeEventListener('visibilitychange', sync); pause(); };
}
