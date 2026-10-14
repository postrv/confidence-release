// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { observeChildHeartbeat } from './heartbeat-observation.mjs';
// Raced filesystem requests can block graceful Node teardown. Failure kills
// this exact parent; the detached child's 150s bound is separate.
const safety = setTimeout(() => process.kill(process.pid, 'SIGKILL'), 10_000);
const result = await observeChildHeartbeat({
  spawn() {
    let state = { kind: 'RUNNING' };
    const child = spawn(process.execPath, ['-e', "const fs=require('node:fs');setInterval(()=>fs.writeFileSync('/workspace/heartbeat.txt',String(Date.now())),100);setTimeout(()=>process.exit(0),150000)"], { detached: true, stdio: 'ignore' });
    child.once('error', () => { state = { kind: 'SPAWN_FAILED' }; });
    child.once('exit', exitCode => { state = { kind: 'EXITED', exitCode }; });
    child.unref(); return { pid: child.pid ?? null, state: () => state };
  },
  async readHeartbeat() {
    try { return await readFile('/workspace/heartbeat.txt', 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  },
  // The host awaits only this parent's exitCode. Never await descendant output.
  writeResult: value => writeFile('/workspace/child-result.json', JSON.stringify(value), { flag: 'wx' }),
  writeDiagnostic: value => writeFile('/workspace/child-diagnostic.json', JSON.stringify(value), { flag: 'wx' }),
});
clearTimeout(safety);
if (result.accepted) process.exit(0);
else process.kill(process.pid, 'SIGKILL');
