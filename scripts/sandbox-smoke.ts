// SPDX-License-Identifier: Apache-2.0
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./cloudflare-test-loader.mjs', import.meta.url);
const { Files } = await import('@cloudflare/sandbox');

// Owned disposable Docker resource: verifies SDK/helper compatibility and inert
// hydration. Cloudflare lifecycle, network interception and Artifacts are separate gates.
const name = `confidence-smoke-${randomUUID()}`;
execFileSync('docker', ['build', '--platform', 'linux/amd64', '-f', 'workers/evaluator/Dockerfile', '-t', 'confidence-checker:smoke', '.'], { stdio: 'inherit' });
execFileSync('docker', ['run', '-d', '--name', name, '--platform', 'linux/amd64', '--network', 'none', '--memory', '256m', '--cpus', '1', 'confidence-checker:smoke'], { stdio: 'ignore' });
try {
  const files = new Files({
    async exec(argv: string[], options?: { cwd?: string }) {
      const child = spawn('docker', ['exec', '-i', ...(options?.cwd ? ['-w', options.cwd] : []), name, ...argv], { stdio: ['pipe', 'pipe', 'pipe'] });
      const exitCode = new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
      return {
        stdin: Writable.toWeb(child.stdin), stdout: Readable.toWeb(child.stdout), stderr: Readable.toWeb(child.stderr),
        pid: child.pid!, isPty: false, exitCode,
        kill() { child.kill('SIGTERM'); }, resize() { throw new Error('No PTY'); },
        async output() { throw new Error('Buffered output disabled'); },
      } as never;
    },
  });
  await files.mkdir('/workspace/nested', { recursive: true });
  const binary = new Uint8Array([0, 255, 37, 128, 10]);
  await files.writeFile('/workspace/nested/source.bin', binary);
  assert.deepEqual(new Uint8Array(await (await files.readFile('/workspace/nested/source.bin')).arrayBuffer()), binary);
  await files.writeFile('/workspace/nested/source.mjs', 'export const value = 42;\n');
  const stat = await files.stat('/workspace/nested/source.mjs');
  assert.equal(stat.type, 'file');
  assert.equal((await files.readDirectory('/workspace/nested')).length, 2);
  await files.remove('/workspace/nested', { recursive: true });
  process.stdout.write(JSON.stringify({ passed: true, sdk: '1.0.0', checks: ['bounded binary hydration', 'source bytes', 'metadata', 'directory enumeration', 'cleanup'], limitations: ['Owned Docker shim compatibility only; Cloudflare generation lifecycle and egress remain live-runtime gates.'] }) + '\n');
} finally { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); }
