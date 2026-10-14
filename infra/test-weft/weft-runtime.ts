// SPDX-License-Identifier: Apache-2.0
// Local test only. Never deploy the generated Worker or its fixed-tool trial.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

export const WEFT_REVISION = 'b1c5521bf28a0144203c55b3f056885dce3535ff';
export type WorkingFiles = Record<string, { text: string; mode: number }>;
interface RuntimeOptions { source?: string; revision?: string; sourceBase?: { repo: string; repositoryId: string; branch: string; oid: string }; gitSeed?: { repository: string; commit: string } }
const run = promisify(execFile);
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

async function archiveSource(source: string, revision: string, directory: string) {
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal((await run('git', ['rev-parse', `${revision}^{commit}`], { cwd: source })).stdout.trim(), revision);
  const archived = join(directory, 'source'); await mkdir(archived);
  await run('git', ['archive', '--format=tar', '-o', join(directory, 'source.tar'), revision], { cwd: source });
  await run('tar', ['-xf', join(directory, 'source.tar'), '-C', archived]);
  // Reads installed dependencies. All build/cache/output writes use the archive.
  await symlink(join(source, 'node_modules'), join(archived, 'node_modules'), 'dir');
  return archived;
}

async function createCoordinator(archived: string, directory: string, external: boolean) {
  const output = join(directory, 'bundle'); await mkdir(output);
  const wrapper = `import worker, { Workspace } from './src/cloud/worker.js';
import { DurableObject } from 'cloudflare:workers';
import { executeModel } from './src/protocol/tools.js';
export { Workspace };
export class DeterministicTestTrial extends DurableObject {
  async run(input) {
    const result = executeModel(input.files, input.tool);
    return { ...result, environment: 'owned-deterministic-fixture', runtime: 'workerd-fixed-tool-model', network: 'none',
      isolation: { profile: 'fixed-file-adapter.v1', cleanup: 'verified' }, testOnly: true };
  }
}
export default worker;
`;
  await writeFile(join(archived, 'confidence-test-worker.js'), wrapper);
  await writeFile(join(archived, 'confidence-test-wrangler.json'), JSON.stringify({
    name: 'confidence-weft-test-only-never-deploy', main: 'confidence-test-worker.js', compatibility_date: '2026-10-08',
    compatibility_flags: ['nodejs_compat'], workers_dev: false, preview_urls: false,
  }));
  await run(resolve('node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--config', join(archived, 'confidence-test-wrangler.json'), '--outdir', output], {
    cwd: archived, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NODE_OPTIONS: '--max-old-space-size=384' }, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  const scripts = (await readdir(output)).filter(file => file.endsWith('.js')); assert.equal(scripts.length, 1);
  const token = 'owned-weft-admin-local-test-only-credential';
  const runtime = new Miniflare(convertV4MiniflareOptions({
    name: 'confidence-weft-owned-runtime', modulesRoot: output, modules: [{ type: 'ESModule', path: join(output, scripts[0]) }],
    compatibilityDate: '2026-10-08', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true }, TRIALS: { className: 'DeterministicTestTrial', useSQLite: true } },
    bindings: { ADMIN_TOKEN: token, RELEASE_AUTHORITY: external ? 'external' : 'standalone' }, r2Buckets: { CONTENT: 'owned-weft-content' }, resourcePersistencePath: join(directory, 'persist'), log: new Log(LogLevel.ERROR),
  }));
  await runtime.ready;
  return { runtime, token, bundleDigest: 'sha256:' + hash(await readFile(join(output, scripts[0]))) };
}

async function bridge(runtime: Miniflare) {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 12 * 1024 * 1024) throw Error('TEST_REQUEST_TOO_LARGE'); chunks.push(chunk); }
      const result = await runtime.dispatchFetch('https://weft.owned.test' + request.url, {
        method: request.method, headers: request.headers as Record<string, string>, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function initialWorktree(primary: string, initial: WorkingFiles, seed?: RuntimeOptions['gitSeed']) {
  if (seed) {
    await run('git', ['clone', '--no-hardlinks', '--single-branch', '--branch', 'main', seed.repository, primary]);
    assert.equal((await run('git', ['rev-parse', 'HEAD'], { cwd: primary })).stdout.trim(), seed.commit);
    for (const [path, file] of Object.entries(initial)) assert.equal(await readFile(join(primary, path), 'utf8'), file.text);
  } else {
    await mkdir(primary);
    for (const [path, file] of Object.entries(initial)) {
      await mkdir(dirname(join(primary, path)), { recursive: true });
      await writeFile(join(primary, path), file.text); await chmod(join(primary, path), file.mode & 0o777);
    }
    await run('git', ['init', '--initial-branch=main'], { cwd: primary });
    await run('git', ['add', '--all'], { cwd: primary });
    await run('git', ['-c', 'user.name=Owned Weft Rehearsal', '-c', 'user.email=weft-owned@localhost', 'commit', '-m', 'test: isolated working source'], { cwd: primary });
  }
  await writeFile(join(primary, '.git/info/exclude'), '.weft/\nnotes.local\n');
  // A real staged mode change differs from both HEAD and the physical file.
  // Weft must preserve that staging decision while editing working bytes.
  const stagedPath = Object.keys(initial)[0]; assert.ok(stagedPath);
  await run('git', ['update-index', initial[stagedPath].mode === 0o100755 ? '--chmod=-x' : '--chmod=+x', '--', stagedPath], { cwd: primary });
  const initialStaging = (await run('git', ['diff', '--cached', '--raw'], { cwd: primary })).stdout; assert.ok(initialStaging);
  return { initialHead: (await run('git', ['rev-parse', 'HEAD'], { cwd: primary })).stdout.trim(), initialIndex: hash(await readFile(join(primary, '.git/index'))), initialStaging };
}

/** Run exact archived production coordinator/replicas with owned deterministic trials. */
export async function weftRuntime(initial: WorkingFiles, options: RuntimeOptions = {}) {
  const configuredSource = options.source ?? process.env.WEFT_SOURCE;
  assert.ok(typeof configuredSource === 'string' && configuredSource.trim(), 'WEFT_SOURCE_REQUIRED: set WEFT_SOURCE or options.source to an authorized pinned Weft checkout.');
  const source = resolve(configuredSource);
  const revision = options.revision || WEFT_REVISION;
  const directory = await mkdtemp(join(tmpdir(), 'confidence-weft-'));
  const cleanup: (() => Promise<void>)[] = [() => rm(directory, { recursive: true, force: true })];
  let disposed = false;
  async function dispose() {
    if (disposed) return; disposed = true;
    const errors = [];
    for (const close of cleanup.reverse()) { try { await close(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Owned Weft fixture cleanup failed');
  }
  try {
  const archived = await archiveSource(source, revision, directory);
  const { runtime, token, bundleDigest } = await createCoordinator(archived, directory, Boolean(options.sourceBase));
  cleanup.push(() => runtime.dispose());
  const { server, endpoint } = await bridge(runtime);
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const { Replica } = await import(pathToFileURL(join(archived, 'src/local/replica.js')).href);
  const { Client } = await import(pathToFileURL(join(archived, 'src/local/client.js')).href);
  const { startDaemon, daemonRequest } = await import(pathToFileURL(join(archived, 'src/local/daemon.js')).href);
  const { durableJson } = await import(pathToFileURL(join(archived, 'src/local/files.js')).href);
  const primary = join(directory, 'primary'), peer = join(directory, 'peer');
  const { initialHead, initialIndex, initialStaging } = await initialWorktree(primary, initial, options.gitSeed); await mkdir(peer);
  const config = { endpoint, workspace: 'confidence-owned-workspace', token };
  const client = new Client(config);
  if (options.sourceBase) await client.call('init', { files: initial, sourceBase: options.sourceBase });
  const primaryReplica = await Replica.join(primary, config, !options.sourceBase);
  const invite = await client.call('invite', { id: 'owned-peer', name: 'Owned peer replica', role: 'edit' });
  const peerReplica = await Replica.join(peer, { ...config, token: invite.token });
  const daemon = await startDaemon(primary, primaryReplica, { pollMs: 60_000 });
  cleanup.push(() => daemon.close());
  await writeFile(join(primary, 'notes.local'), 'Unrelated private local notes; preserve byte for byte.\n');
  const independentSession = join(directory, 'session.mjs');
  await writeFile(independentSession, `import { daemonRequest } from ${JSON.stringify(pathToFileURL(join(archived, 'src/local/daemon.js')).href)};
const input = JSON.parse(process.argv[2]);
const startedAt = Date.now();
const result = await daemonRequest(input.root, 'tool', { session: input.session, tool: input.tool });
const toolCompletedAt = Date.now();
// Keep the owned deterministic client alive briefly so simultaneous launches
// demonstrate overlapping process lifetimes independently of OS startup jitter.
await new Promise(resolve => setTimeout(resolve, 250));
process.stdout.write(JSON.stringify({ pid: process.pid, session: input.session, startedAt, toolCompletedAt, endedAt: Date.now(), result }));\n`);
  const sessions: { pid: number; session: string; startedAt: number; toolCompletedAt: number; endedAt: number; result: any }[] = [];
  return {
    sourceRevision: revision, directory, endpoint, workspace: config.workspace, token, primary, peer, client, primaryReplica, peerReplica,
    async fetch(url: string | URL, init?: RequestInit) {
      const request = new Request(url, init);
      return runtime.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }) });
    },
    async session(session: string, tool: unknown) {
      const child = await run(process.execPath, ['--max-old-space-size=128', independentSession, JSON.stringify({ root: primary, session, tool })], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
      const result = JSON.parse(child.stdout); sessions.push(result); return result.result;
    },
    async syncPeer() { await peerReplica.sync(); return peerReplica.status(); },
    async selection(revision: number) { return client.call(`sync/revisions/${revision}`); },
    async useConfidence(transport: typeof fetch, credentials: { primary: string; peer: string }, applicationEndpoint: string) {
      // The test transports Weft's existing Client requests through Confidence's
      // real authenticated project route; no Weft service token reaches either replica.
      for (const [replica, credential] of [[primaryReplica, credentials.primary], [peerReplica, credentials.peer]]) {
        replica.config = { ...replica.config, endpoint: applicationEndpoint, applicationOrigin: new URL(applicationEndpoint).origin, token: credential };
        replica.client = new Client(replica.config, transport);
        await durableJson(replica.local('config.json'), replica.config);
      }
    },
    async assertPreserved() {
      assert.equal((await run('git', ['rev-parse', 'HEAD'], { cwd: primary })).stdout.trim(), initialHead);
      assert.equal(hash(await readFile(join(primary, '.git/index'))), initialIndex);
      assert.equal((await run('git', ['diff', '--cached', '--raw'], { cwd: primary })).stdout, initialStaging);
      assert.equal(await readFile(join(primary, 'notes.local'), 'utf8'), 'Unrelated private local notes; preserve byte for byte.\n');
      return { sourceHead: initialHead, indexDigest: initialIndex, headPreserved: true, indexPreserved: true, stagedModeChangePreserved: true, unrelatedDirtyFilePreserved: true };
    },
    async evidence() {
      return { sourceRevision: revision, bundleDigest, environment: 'local-workerd', trials: 'owned deterministic fixed-tool test fixture; not native-agent or container qualification',
        independentSessions: sessions.map(({ pid, session, startedAt, toolCompletedAt, endedAt, result }) => ({ pid, session, startedAt, toolCompletedAt, endedAt, operation: result.id, state: result.state, acceptedRevision: result.acceptedRevision })),
        sharedPhysicalWorktree: true, primary: await daemonRequest(primary, 'status'), peer: await peerReplica.status(), ...(await this.assertPreserved()) };
    },
    dispose,
  };
  } catch (error) { await dispose(); throw error; }
}
