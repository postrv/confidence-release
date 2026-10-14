// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshQueue, startVisiblePolling } from '../../apps/web/src/polling.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class Visibility {
  hidden = false;
  listeners = new Set<() => void>();
  addEventListener(type: 'visibilitychange', listener: () => void) { assert.equal(type, 'visibilitychange'); this.listeners.add(listener); }
  removeEventListener(type: 'visibilitychange', listener: () => void) { assert.equal(type, 'visibilitychange'); this.listeners.delete(listener); }
  change(hidden: boolean) { this.hidden = hidden; for (const listener of this.listeners) listener(); }
}

class Clock {
  next = 0;
  intervals = new Map<number, { callback: () => void; delayMs: number }>();
  setInterval(callback: () => void, delayMs: number) { const id = ++this.next; this.intervals.set(id, { callback, delayMs }); return id; }
  clearInterval(id: number) { this.intervals.delete(id); }
  tick() { for (const { callback } of [...this.intervals.values()]) callback(); }
}

test('visible snapshot polling pauses while hidden and reads immediately on return', () => {
  const visibility = new Visibility(), clock = new Clock();
  let reads = 0;
  const refresh = () => { reads++; };
  const stop = startVisiblePolling(visibility, clock, refresh);
  assert.equal(reads, 1);
  assert.deepEqual([...clock.intervals.values()].map(value => value.delayMs), [2500]);
  clock.tick(); assert.equal(reads, 2);

  visibility.change(true);
  assert.equal(clock.intervals.size, 0);
  clock.tick(); assert.equal(reads, 2);
  refresh(); assert.equal(reads, 3, 'manual and command refreshes remain independent of scheduled polling');

  visibility.change(false);
  assert.equal(reads, 4, 'returning to the tab starts with an immediate read');
  assert.equal(clock.intervals.size, 1);
  clock.tick(); assert.equal(reads, 5);
  stop();
  assert.equal(clock.intervals.size, 0);
  assert.equal(visibility.listeners.size, 0);
});

test('a page opened in the background waits for visibility and does not leak a timer', () => {
  const visibility = new Visibility(), clock = new Clock();
  visibility.hidden = true;
  let reads = 0;
  const stop = startVisiblePolling(visibility, clock, () => { reads++; });
  assert.equal(reads, 0);
  assert.equal(clock.intervals.size, 0);
  visibility.change(false);
  assert.equal(reads, 1);
  visibility.change(false);
  assert.equal(reads, 1, 'duplicate visibility events do not duplicate immediate reads');
  stop();
  visibility.change(true);
  visibility.change(false);
  assert.equal(reads, 1, 'cleanup removes the listener');
});

test('a command queues one full refresh behind a stale in-flight poll, even when polling pauses', async () => {
  const visibility = new Visibility(), clock = new Clock(), stalePoll = deferred();
  let live = 'before-command', displayed = '', reads = 0;
  const forces: boolean[] = [];
  const refresh = createRefreshQueue(async force => {
    forces.push(force);
    const captured = live;
    if (++reads === 1) await stalePoll.promise;
    displayed = captured;
  });
  const stop = startVisiblePolling(visibility, clock, () => { void refresh(); });
  await Promise.resolve();
  assert.deepEqual(forces, [false]);

  live = 'after-command';
  visibility.change(true);
  const forced = refresh(true);
  assert.strictEqual(refresh(true), forced, 'multiple command refresh requests share one queued full read');
  assert.deepEqual(forces, [false], 'the full read waits for the pre-command poll');

  stalePoll.resolve();
  await forced;
  assert.deepEqual(forces, [false, true]);
  assert.equal(displayed, 'after-command', 'the hidden tab receives the post-command snapshot without a polling tick');
  stop();
});
