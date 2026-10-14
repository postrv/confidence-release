import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalPlatform } from '../../services/platform.ts';

const alive = (pid: number, group = false) => { try { process.kill(group ? -pid : pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
async function until(check: () => Promise<boolean> | boolean) { const deadline = Date.now() + 10_000; while (!await check()) { if (Date.now() > deadline) throw new Error('Owned fixture did not reach expected state'); await delay(20); } }
async function previewGroups(platform: LocalPlatform, rows: () => Promise<any[]>, calls: () => number) {
  // Three cold Pi SDKs and analyzer fixtures can start slowly on emulated CI.
  // This bounds setup only; production authoring, preview and cleanup timers stay unchanged.
  const started = performance.now(), deadline = started + 30_000;
  while (true) {
    const markers = await rows(), modelCalls = calls();
    const attempts = platform.state.attempts.map(attempt => ({ role: attempt.role, status: attempt.status,
      invalid: attempt.previewLifecycle?.invalid, runs: attempt.previewLifecycle?.runs.map(run => ({ state: run.state, pid: run.pid, terminationObserved: run.terminationObserved })) ?? [] }));
    const fail = (reason: string): never => { throw new Error(`Owned preview setup ${reason}: ${JSON.stringify({ elapsedMs: Math.round(performance.now() - started), markerCount: markers.length, modelCalls, demoStatus: platform.state.demoStatus, attempts })}`); };
    if (modelCalls > 3 || markers.length > 3 || platform.state.demoStatus === 'ERROR'
      || attempts.some(attempt => !['PROVISIONING', 'RUNNING'].includes(attempt.status) || attempt.invalid || attempt.runs.some(run => run.state === 'SETTLED')))
      fail('settled or failed before cancellation');
    if (!markers.every(marker => alive(marker.pid, true) && alive(marker.descendant))) fail('has dead process markers');
    if (markers.length === 3 && attempts.length === 3 && modelCalls === 3) {
      if (attempts.every(attempt => attempt.status === 'RUNNING' && attempt.runs.length === 1 && attempt.runs[0].state === 'RUNNING')) {
        const markerPids = new Set(markers.map(marker => marker.pid)), runningPids = new Set(attempts.map(attempt => attempt.runs[0].pid));
        if (markerPids.size !== 3 || runningPids.size !== 3 || ![...runningPids].every(pid => markerPids.has(pid))) fail('has duplicate or unbound process markers');
        return markers;
      }
    }
    if (performance.now() > deadline) fail('deadline exceeded');
    await delay(20);
  }
}
async function owned(body: (platform: LocalPlatform, directory: string, rows: () => Promise<any[]>, calls: () => number) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-preview-cancellation-')), cliPath = join(directory, 'preview.mjs'), marker = join(directory, 'groups.jsonl');
  await writeFile(cliPath, `import{spawn}from'node:child_process';import{appendFileSync}from'node:fs';
const descendant=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'});
appendFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,descendant:descendant.pid,cwd:process.cwd(),home:process.env.HOME,tmp:process.env.TMPDIR,providerCredentialPresent:!!process.env.OPENAI_API_KEY})+'\\n');
process.stdin.resume();setInterval(()=>{},100);`);
  const settings = { PI_MODEL: 'owned-cancel', PI_MODEL_BASE_URL: 'https://owned-cancel.invalid/v1', OPENAI_API_KEY: 'owned-test-only', CONFIDENCE_NARSIL_CONTEXT: 'off', CONFIDENCE_INTERLINKED_PREVIEW: 'feedback', CONFIDENCE_INTERLINKED_CLI: cliPath };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]])), fetch = globalThis.fetch;
  Object.assign(process.env, settings); let calls = 0;
  globalThis.fetch = async (url: any, init: any) => {
    if (String(url) !== settings.PI_MODEL_BASE_URL + '/chat/completions') return fetch(url, init);
    calls++; const request = JSON.parse(init.body), message = request.messages.find((item: any) => item.role === 'user').content;
    const task = JSON.parse(typeof message === 'string' ? message : message.map((part: any) => part.text ?? '').join(''));
    const path = task.allowedPaths[0];
    return new Response(JSON.stringify({ id: 'owned-cancel', object: 'chat.completion', created: 1, model: settings.PI_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ files: { [path]: task.source[path] + '\n// proposed change must never be written\n' } }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { headers: { 'content-type': 'application/json' } });
  };
  const rows = async () => (await readFile(marker, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const platform = new LocalPlatform(join(directory, 'data'));
  try { await platform.initialize(); await body(platform, directory, rows, () => calls); }
  finally {
    // Cleanup even on RED: the old adapter leaves these independently owned groups alive.
    for (const row of await rows()) { try { process.kill(-row.pid, 'SIGKILL'); } catch { /* Already absent. */ } }
    await platform.shutdown(); globalThis.fetch = fetch;
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertSettled(platform: LocalPlatform, rows: any[], calls: number) {
  assert.equal(calls, 3, 'Cancellation cannot dispatch a correction model call');
  for (const row of rows) {
    assert.equal(alive(row.pid, true), false, 'Preview group must be absent'); assert.equal(alive(row.descendant), false, 'Preview descendant must be absent');
    assert(row.home.startsWith(join(platform.directory, 'private-config') + '/')); assert.equal(row.tmp, join(row.home, 'tmp')); assert.equal(row.providerCredentialPresent, false);
  }
  for (const attempt of platform.state.attempts) {
    assert.equal(attempt.status, 'FAILED', attempt.error ?? 'Attempt must fail after cancellation'); assert.equal(attempt.terminationObserved, true); if (attempt.reservation) assert.equal(attempt.reservation.status, 'RELEASED');
    const source = await platform.git.files(attempt.workBase!);
    for (const path of attempt.allowedPaths) assert.deepEqual(await readFile(join(platform.directory, 'workspaces', attempt.id, path)), source[path]);
    const journal = (attempt as any).previewLifecycle;
    assert.equal(journal.hostOwned, true); assert(journal.runs.length === 1 && journal.runs.every((run: any) => run.state === 'SETTLED' && run.terminationObserved));
  }
  assert.equal(platform.state.capsules.length, 0); assert(platform.state.candidates.every(candidate => candidate.attemptIds.length === 0));
}

test('local shutdown drains preview leaders and descendants before releasing attempts and applies no proposal', { timeout: 60_000 }, async () => owned(async (platform, _directory, rows, calls) => {
  await platform.startDemo({ mode: 'pi', autoSelect: false, commandId: 'owned-preview-shutdown' });
  const started = await previewGroups(platform, rows, calls);
  await platform.shutdown(); await assertSettled(platform, started, calls());
}));

test('abrupt Pi SIGKILL aborts host-owned previews and observes every group absent', { timeout: 60_000 }, async () => owned(async (platform, _directory, rows, calls) => {
  await platform.startDemo({ mode: 'pi', autoSelect: false, commandId: 'owned-preview-hard-kill' });
  const started = await previewGroups(platform, rows, calls);
  for (const attempt of platform.state.attempts) process.kill(-attempt.pid!, 'SIGKILL');
  await platform.waitForIdle(); await assertSettled(platform, started, calls());
}));

test('incomplete, missing and invalid required preview journals cannot reconcile from Pi PID absence', { timeout: 60_000 }, async () => owned(async (platform, directory, rows, calls) => {
  await platform.startDemo({ mode: 'pi', autoSelect: false, commandId: 'owned-preview-journal' });
  await previewGroups(platform, rows, calls); await platform.shutdown();
  const path = join(platform.directory, 'authority/state.json'), state = JSON.parse(await readFile(path, 'utf8')), attempt = state.attempts[0];
  attempt.status = 'INFRASTRUCTURE_UNKNOWN'; attempt.terminationObserved = false; attempt.reservation = { id: 'owned-reservation', authoringSeconds: 120, status: 'HELD' };
  const emptyJournal = { schemaVersion: 1, hostOwned: true, invalid: false, runs: [] };
  for (const [transport, journal] of [
    ['host-ipc-v1', undefined],
    ['host-ipc-v1', { ...emptyJournal, runs: [{ round: 0, state: 'PREPARING', terminationObserved: false }] }],
    ['host-ipc-v1', { ...emptyJournal, invalid: true }],
    [undefined, emptyJournal], ['unsupported-transport', emptyJournal],
  ]) {
    attempt.previewTransport = transport; attempt.previewLifecycle = journal;
    await writeFile(path, JSON.stringify(state));
    const restarted = new LocalPlatform(join(directory, 'data'));
    try {
      await restarted.initialize(); await restarted.reconcile();
      const retained = restarted.state.attempts.find(row => row.id === attempt.id)!;
      assert.equal(retained.status, 'INFRASTRUCTURE_UNKNOWN'); assert.equal(retained.terminationObserved, false); assert.equal(retained.reservation?.status, 'HELD');
      await assert.rejects(restarted.startDemo({ mode: 'pi' }), /UNKNOWN|HELD|CAPACITY|AVAILABLE/);
    } finally { await restarted.shutdown(); }
  }
}));

test('restart only observes a persisted group and never signals a possibly reused PID', { timeout: 15_000 }, async () => owned(async (platform, directory) => {
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},100)'], { detached: true, stdio: 'ignore' });
  const exited = new Promise<void>(resolve => sleeper.once('exit', () => resolve()));
  const attempt = await (platform as any).newAttempt('A', 'pi', platform.state.acceptedHead);
  attempt.pid = sleeper.pid; attempt.status = 'RUNNING'; attempt.terminationObserved = false;
  attempt.previewTransport = 'host-ipc-v1'; attempt.previewLifecycle = { schemaVersion: 1, hostOwned: true, invalid: false, runs: [{ round: 0, state: 'RUNNING', pid: sleeper.pid, terminationObserved: false }] };
  attempt.reservation = { id: 'owned-restart-reservation', authoringSeconds: 120, status: 'HELD' }; await platform.save();
  const restarted = new LocalPlatform(join(directory, 'data'));
  try {
    await restarted.initialize(); await restarted.reconcile();
    const retained = restarted.state.attempts.find(row => row.id === attempt.id)!;
    assert.equal(alive(sleeper.pid!, true), true); assert.equal(retained.status, 'INFRASTRUCTURE_UNKNOWN'); assert.equal(retained.reservation?.status, 'HELD');
    process.kill(-sleeper.pid!, 'SIGKILL'); await exited;
    await restarted.reconcile(); assert.equal(retained.status, 'FAILED'); assert.equal(retained.terminationObserved, true); assert.equal(retained.reservation?.status, 'RELEASED');
  } finally { if (alive(sleeper.pid!, true)) process.kill(-sleeper.pid!, 'SIGKILL'); await exited; await restarted.shutdown(); }
}));

test('authoring stop during held preview preparation cancels dispatch before any analyzer starts', { timeout: 15_000 }, async () => owned(async (platform, _directory, rows, calls) => {
  // The production deadline callback invokes stopAuthoring. Trigger that same
  // path after PREPARING is observed, independent of Pi startup speed.
  platform.state.goal.budget.authoringSeconds = 30;
  const attempt = await (platform as any).newAttempt('A', 'pi', platform.state.acceptedHead);
  const save = platform.save.bind(platform); let held = false, release!: () => void;
  const preparation = new Promise<void>(resolve => { release = resolve; });
  platform.save = async () => {
    if (!held && attempt.previewLifecycle?.runs[0]?.state === 'PREPARING') { held = true; await preparation; }
    await save();
  };
  const execution = (platform as any).executeAttempt(attempt);
  let stopping: Promise<boolean> | undefined;
  try {
    await until(() => held);
    const child = (platform as any).children.get(attempt.id);
    assert(child, 'Pi owner must be running while preview preparation is held');
    stopping = (platform as any).stopAuthoring(child, attempt);
    await until(() => (platform as any).stoppingAttempts.has(attempt.id));
    assert.equal((await rows()).length, 0);
  } finally {
    release();
    const outcomes = await Promise.allSettled([stopping, execution].filter(Boolean));
    platform.save = save;
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }
  assert.equal(calls(), 1); assert.equal((await rows()).length, 0);
  assert.equal(attempt.status, 'FAILED'); assert.equal(attempt.terminationObserved, true);
  assert.equal(attempt.previewLifecycle.runs[0].state, 'SETTLED');
  const source = await platform.git.files(attempt.workBase);
  assert.deepEqual(await readFile(join(platform.directory, 'workspaces', attempt.id, attempt.allowedPaths[0])), source[attempt.allowedPaths[0]]);
}));

test('lifecycle persistence rejection cancels Pi and retains unknown capacity even after physical cleanup', { timeout: 30_000 }, async () => owned(async (platform, _directory, rows, calls) => {
  for (const phase of ['PREPARING', 'RUNNING']) {
    const attempt = await (platform as any).newAttempt('A', 'pi', platform.state.acceptedHead);
    attempt.reservation = { id: 'owned-persistence-reservation', authoringSeconds: 120, status: 'HELD' };
    const save = platform.save.bind(platform); let preparingSaves = 0, injected = false;
    platform.save = async () => {
      const run = attempt.previewLifecycle?.runs[0];
      if (run?.state === 'PREPARING') preparingSaves++;
      // The first PREPARING save precedes the adapter; the second is its callback.
      if (!injected && (phase === 'PREPARING' ? preparingSaves === 2 : run?.state === 'RUNNING')) { injected = true; throw new Error('Owned lifecycle persistence failure'); }
      await save();
    };
    try { await (platform as any).executeAttempt(attempt); } finally { platform.save = save; }
    assert.equal(injected, true); assert.equal(attempt.status, 'INFRASTRUCTURE_UNKNOWN'); assert.equal(attempt.terminationObserved, false);
    assert.equal(attempt.previewLifecycle.invalid, true); assert.equal(attempt.reservation.status, 'HELD');
    await platform.reconcile(); assert.equal(attempt.status, 'INFRASTRUCTURE_UNKNOWN'); assert.equal(attempt.reservation.status, 'HELD');
    if (attempt.previewLifecycle.runs[0].pid) assert.equal(alive(attempt.previewLifecycle.runs[0].pid, true), false);
    const source = await platform.git.files(attempt.workBase);
    assert.deepEqual(await readFile(join(platform.directory, 'workspaces', attempt.id, attempt.allowedPaths[0])), source[attempt.allowedPaths[0]]);
  }
  assert.equal(calls(), 2); assert.equal(platform.state.capsules.length, 0);
  for (const row of await rows()) assert.equal(alive(row.pid, true), false);
  await assert.rejects(platform.review({ candidateId: 'owned-not-a-candidate' }), /AUTHORING_PREVIEW_UNRESOLVED/);
}));
