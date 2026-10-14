// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { GitStore } from '../../services/git.ts';
const run = promisify(execFile);
export const OWNED_ARTIFACTS_HOST = '1'.repeat(32) + '.artifacts.cloudflare.net';
export const OWNED_REPOSITORY = 'confidence-weft-owned';

/** Real Git smart-HTTP transport in temporary repositories; no Artifacts service claim. */
export async function ownedGit() {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-weft-git-'));
  const canonical = join(directory, OWNED_REPOSITORY + '.git');
  const git = new GitStore(join(directory, 'evaluation.git'), canonical);
  const base = await git.initialize(resolve('fixtures/collaboration-demo'));
  await run('git', ['--git-dir', canonical, 'config', 'http.receivepack', 'true']);
  await run('git', ['--git-dir', canonical, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const remote = `https://${OWNED_ARTIFACTS_HOST}/git/owned/${OWNED_REPOSITORY}.git`;
  const token = 'owned-git-transport-test-only'; let writes = 0;
  return {
    directory, canonical, git, base, remote, token,
    async head() { return (await run('git', ['--git-dir', canonical, 'rev-parse', 'refs/heads/main'])).stdout.trim(); },
    writes: () => writes,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url), root = new URL(remote);
      if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname + '/') || request.headers.get('authorization') !== `Bearer ${token}`) return new Response('Owned route denied', { status: 403 });
      if (!['GET', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      const suffix = url.pathname.slice(root.pathname.length);
      if (!['/info/refs', '/git-upload-pack', '/git-receive-pack'].includes(suffix)) return new Response('Not found', { status: 404 });
      if (suffix === '/git-receive-pack') writes++;
      const body = Buffer.from(await request.arrayBuffer()); assert.ok(body.length <= 32 * 1024 * 1024);
      const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', 'http-backend'], {
        env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: `/${OWNED_REPOSITORY}.git${suffix}`, QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers.get('content-type') || '', CONTENT_LENGTH: String(body.length), REMOTE_USER: 'owned-test', SERVER_PROTOCOL: 'HTTP/1.1' },
        encoding: 'buffer', timeout: 15_000, maxBuffer: 32 * 1024 * 1024,
      });
      const output = new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []; let length = 0, stderr = '';
        child.stdout!.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 32 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
        child.stderr!.on('data', chunk => { if (stderr.length < 2048) stderr += chunk; });
        child.on('error', reject); child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(Error(`Owned Git backend failed ${code}: ${stderr}`)));
      });
      child.stdin!.end(body);
      const bytes = await output, separator = bytes.indexOf('\r\n\r\n'); assert.ok(separator >= 0);
      const headers = new Headers(); let status = 200;
      for (const line of bytes.subarray(0, separator).toString('utf8').split('\r\n')) {
        const colon = line.indexOf(':'); assert.ok(colon > 0);
        const name = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.slice(0, 3)); else headers.set(name, value);
      }
      return new Response(new Uint8Array(bytes.subarray(separator + 4)).buffer, { status, headers });
    },
    async dispose() { await rm(directory, { recursive: true, force: true }); },
  };
}
