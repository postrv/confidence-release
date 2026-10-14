// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { observeChildHeartbeat } from './heartbeat-observation.mjs';
function fixture(overrides = {}) {
  let now = 0, spawns = 0, reads = 0; const results = [], diagnostics = [];
  let nextTimer = 0; const timers = new Map();
  const advance = milliseconds => { now += milliseconds; for (const [id, timer] of Array.from(timers)) if (timer.at <= now) { timers.delete(id); timer.callback(); } };
  const deps = { now: () => now, wait: async milliseconds => { advance(milliseconds); },
    setTimer: (callback, milliseconds) => { const id = ++nextTimer; timers.set(id, { callback, at: now + milliseconds }); return id; }, clearTimer: id => { timers.delete(id); },
    spawn: () => { spawns++; return { pid: 42, state: () => ({ kind: 'RUNNING' }) }; },
    readHeartbeat: async () => { reads++; return now < 700 ? null : String(1791170000000 + now); },
    writeResult: async value => { results.push(value); }, writeDiagnostic: async value => { diagnostics.push(value); }, ...overrides };
  return { deps, results, diagnostics, advance, get now() { return now; }, get spawns() { return spawns; }, get reads() { return reads; } };
}
test('delayed first heartbeat beyond350ms is observed once before shared deadline', async () => {
  const f = fixture(); assert.deepEqual(await observeChildHeartbeat(f.deps), { accepted: true });
  assert.equal(f.spawns, 1); assert.equal(f.results.length, 1); assert.equal(f.diagnostics.length, 0);
  assert.equal(f.now, 800); assert.notEqual(f.results[0].first, f.results[0].second);
});
test('the first and changed observations consume one10second budget', async () => {
  const f = fixture(); f.deps.readHeartbeat = async () => f.now < 9_000 ? null : '1791170000000';
  assert.deepEqual(await observeChildHeartbeat(f.deps), { accepted: false, diagnosticWritten: true });
  assert.equal(f.now, 9_500); assert.equal(f.spawns, 1); assert.equal(f.results.length, 0);
  assert.equal(f.diagnostics[0].code, 'CHANGED_HEARTBEAT_TIMEOUT'); assert.equal(f.diagnostics[0].elapsedMs, 9_500);
});
test('a missing first heartbeat produces one bounded diagnostic and no repeat spawn', async () => {
  const f = fixture({ readHeartbeat: async () => null }); await observeChildHeartbeat(f.deps);
  assert.equal(f.now, 9_500); assert.equal(f.spawns, 1); assert.equal(f.results.length, 0);
  assert.equal(f.diagnostics.length, 1); assert.equal(f.diagnostics[0].code, 'FIRST_HEARTBEAT_TIMEOUT');
  assert.ok(JSON.stringify(f.diagnostics[0]).length < 1024);
});
test('synchronous and asynchronous spawn failures retain only closed metadata', async () => {
  for (const spawn of [() => { throw Error('PRIVATE_SPAWN_DETAIL'); }, () => ({ pid: null, state: () => ({ kind: 'SPAWN_FAILED' }) })]) {
    const f = fixture({ spawn }); await observeChildHeartbeat(f.deps);
    assert.equal(f.results.length, 0); assert.equal(f.diagnostics.length, 1);
    assert.equal(f.diagnostics[0].code, 'SPAWN_FAILED'); assert.equal(f.diagnostics[0].stage, 'SPAWN');
    assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE_SPAWN_DETAIL'));
  }
});
test('child exit and invalid heartbeat never become acceptance observations', async () => {
  for (const [overrides, code] of [[{ spawn: () => ({ pid: 42, state: () => ({ kind: 'EXITED', exitCode: 7 }) }) }, 'CHILD_EXITED'], [{ readHeartbeat: async () => 'bad timestamp' }, 'HEARTBEAT_INVALID']]) {
    const f = fixture(overrides); await observeChildHeartbeat(f.deps);
    assert.equal(f.results.length, 0); assert.equal(f.diagnostics[0].code, code);
  }
});
test('exclusive result write failure cannot retry child or expose filesystem errors', async () => {
  const f = fixture({ writeResult: async () => { throw Error('PRIVATE_FILESYSTEM_DETAIL'); } });
  await observeChildHeartbeat(f.deps); assert.equal(f.spawns, 1); assert.equal(f.diagnostics.length, 1);
  assert.equal(f.diagnostics[0].stage, 'RESULT_WRITE'); assert.equal(f.diagnostics[0].code, 'RESULT_WRITE_FAILED');
  assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE_FILESYSTEM_DETAIL'));
});
test('late reads cannot exceed the shared deadline and become a successful result', async () => {
  let time = 0; const f = fixture({ now: () => time, readHeartbeat: async () => { time = 10_001; return '1791170000000'; } });
  const result = await observeChildHeartbeat(f.deps); assert.equal(f.results.length, 0); assert.equal(result.accepted, false); assert.equal(result.diagnosticWritten, false);
});
test('diagnostic write loss remains a failure without repeating any write or spawn', async () => {
  let writes = 0; const f = fixture({ readHeartbeat: async () => null, writeDiagnostic: async () => { writes++; throw Error('PRIVATE_WRITE_FAILURE'); } });
  assert.deepEqual(await observeChildHeartbeat(f.deps), { accepted: false, diagnosticWritten: false });
  assert.equal(writes, 1); assert.equal(f.spawns, 1);
});

test('a successful result write crossing the shared deadline cannot be accepted', async () => {
  const f = fixture(); f.deps.writeResult = async value => { f.results.push(value); f.advance(20_000); };
  assert.deepEqual(await observeChildHeartbeat(f.deps), { accepted: false, diagnosticWritten: false });
  assert.equal(f.spawns, 1); assert.equal(f.results.length, 1); assert.equal(f.diagnostics.length, 0);
});
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
test('unresolved heartbeat reads are raced against the observation deadline', async () => {
  const f = fixture({ readHeartbeat: async () => new Promise(() => {}) });
  const result = observeChildHeartbeat(f.deps); await settle(); f.advance(9500);
  assert.deepEqual(await result, { accepted: false, diagnosticWritten: true });
  assert.equal(f.spawns, 1); assert.equal(f.diagnostics[0].code, 'FIRST_HEARTBEAT_TIMEOUT');
});
test('unresolved result writes cannot extend observation or report acceptance', async () => {
  const f = fixture({ readHeartbeat: async () => '1791170000000' }); let reads = 0;
  f.deps.readHeartbeat = async () => String(1791170000000 + reads++);
  f.deps.writeResult = async () => new Promise(() => {});
  const result = observeChildHeartbeat(f.deps); await settle(); await settle(); f.advance(9500);
  assert.deepEqual(await result, { accepted: false, diagnosticWritten: true });
  assert.equal(f.diagnostics[0].code, 'RESULT_WRITE_FAILED'); assert.equal(f.spawns, 1);
});
test('unresolved diagnostic writes receive at most500ms inside the total budget', async () => {
  const f = fixture({ spawn: () => { throw Error('PRIVATE'); }, writeDiagnostic: async () => new Promise(() => {}) });
  const result = observeChildHeartbeat(f.deps); await settle(); f.advance(500);
  assert.deepEqual(await result, { accepted: false, diagnosticWritten: false }); assert.equal(f.now, 500);
});
test('actual child entry forcibly terminates its exact parent despite pending filesystem read', async () => {
  const directory = fileURLToPath(new URL(`.runs/child-exit-${randomUUID()}/`, import.meta.url));
  await mkdir(directory, { recursive: true }); const fifo = `${directory}pending`, diagnostic = `${directory}diagnostic.json`;
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  let parent, timer;
  try {
    const original = await readFile(new URL('./child.mjs', import.meta.url), 'utf8');
    const source = original.replace("import { spawn } from 'node:child_process';", "const spawn = () => ({pid:42, once(){}, unref(){}}); setInterval(()=>{},1000);")
      .replace("import { readFile, writeFile } from 'node:fs/promises';", `import {readFile as actualRead,writeFile as actualWrite} from 'node:fs/promises'; const readFile=()=>actualRead(${JSON.stringify(fifo)},'utf8'); const writeFile=(_path,value,options)=>actualWrite(${JSON.stringify(diagnostic)},value,options);`)
      .replace("'./heartbeat-observation.mjs'", JSON.stringify(new URL('./heartbeat-observation.mjs', import.meta.url).href));
    assert.notEqual(source, original);
    const started = Date.now(); parent = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
    const observed = await new Promise(resolve => { timer = setTimeout(() => { parent.kill('SIGKILL'); }, 12_000); parent.once('close', (code, signal) => resolve({ code, signal })); });
    assert.equal(observed.code, null); assert.equal(observed.signal, 'SIGKILL'); assert.ok(Date.now() - started < 11_500);
    const value = JSON.parse(await readFile(diagnostic, 'utf8')); assert.equal(value.code, 'FIRST_HEARTBEAT_TIMEOUT');
    assert.equal(value.stage, 'FIRST_HEARTBEAT'); assert.ok(value.elapsedMs >= 9500 && value.elapsedMs < 10000);
  } finally { clearTimeout(timer); if (parent?.exitCode === null) parent.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});
