// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { privateWranglerEnvironment } from '../scripts/provider-preflight.ts';
export type StageResult = { exitCode: number | null; stdoutDigest: string; stderrDigest: string; apiErrorCodes: number[]; errorCategory?: string };
export function stageErrorCategory(output: string, timedOut: boolean, code: number | null): string | undefined {
  if (timedOut) return 'TIMEOUT';
  if (code === 0) return undefined;
  if (/Worker version was deployed, but[\s\S]*could not finish applying/i.test(output)) return 'POST_UPLOAD_CONTAINER_SETTINGS';
  if (/auth token has expired|token-expired|authentication error|not authenticated/i.test(output)) return 'AUTHENTICATION';
  if (/\[code: [0-9]{1,9}\]/.test(output)) return 'PROVIDER_API';
  if (/fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(output)) return 'NETWORK';
  return 'CLI_FAILURE';
}
/** Output is hashed, inspected in bounded memory, and never persisted verbatim. */
export async function runWranglerStage(root: string, args: string[], useWrangler = true, timeout = 300000): Promise<StageResult> {
  const stdout = createHash('sha256'), stderr = createHash('sha256'); let captured = '', timedOut = false, spawnFailed = false;
  const child = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], { cwd: root,
    env: useWrangler ? privateWranglerEnvironment(process.env) : { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_SANITIZE: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = (digest: ReturnType<typeof createHash>) => (chunk: Buffer) => { digest.update(chunk); if (captured.length < 512 * 1024) captured += chunk.toString().slice(0, 512 * 1024 - captured.length); };
  child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
  let exitCode: number | null = null, drainTimedOut = false;
  await new Promise<void>(accept => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined, killTimer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(drainTimer);
      child.removeListener('close', closed); child.removeListener('exit', exited);
      // A descendant can retain a pipe after the CLI exits. Detach boundedly;
      // this is uncertainty, not proof that every descendant has terminated.
      child.stdout.removeAllListeners('data'); child.stderr.removeAllListeners('data');
      child.stdout.destroy(); child.stderr.destroy(); child.unref(); accept();
    };
    const closed = (code: number | null) => { exitCode = code; finish(); };
    const exited = (code: number | null) => {
      exitCode = code;
      drainTimer = setTimeout(() => { drainTimedOut = true; finish(); }, 1000);
    };
    child.once('close', closed); child.once('exit', exited);
    child.on('error', () => { if (!settled) { spawnFailed = true; finish(); } });
    timer = setTimeout(() => {
      timedOut = true; child.kill('SIGTERM');
      killTimer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 5000);
    }, timeout);
  });
  const errorCategory = spawnFailed ? 'SPAWN_FAILURE' : drainTimedOut ? 'OUTPUT_DRAIN_TIMEOUT' : stageErrorCategory(captured, timedOut, exitCode);
  return { exitCode, stdoutDigest: `sha256:${stdout.digest('hex')}`, stderrDigest: `sha256:${stderr.digest('hex')}`,
    apiErrorCodes: [...new Set([...captured.matchAll(/\[code: ([0-9]{1,9})\]/g)].map(match => Number(match[1])))].slice(0, 32), ...(errorCategory ? { errorCategory } : {}) };
}
