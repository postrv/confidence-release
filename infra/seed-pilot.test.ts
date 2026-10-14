// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { seedPilot, fixtureSource, type SeedOptions } from './seed-pilot.ts';

const run = promisify(execFile), accountId = '1'.repeat(32), apiToken = 'owned-api-token-not-a-real-secret', repoToken = 'owned-repository-token-not-a-real-secret';
const config = { accountId, artifactsNamespace: 'owned-namespace', repository: 'owned-collaboration-demo' };

test('closed Biome preset preserves the deterministic four-file baseline and adds only fixed configuration bytes', async () => {
  const baseline = await fixtureSource(), covered = await fixtureSource('authoring-biome-v1'), repeated = await fixtureSource('authoring-biome-v1');
  // Frozen before the optional preset was introduced.
  assert.equal(baseline.candidate.commit, 'e7784b575869f707fdb9b9d2b315a0baaacab7d7');
  assert.equal(baseline.manifestDigest, 'sha256:bce623fd1e98e691845ee6202822a79c10eab08d31bbecfa2b514d67c8b170f2');
  assert.deepEqual(covered.manifest.entries.map(entry => entry.path), ['biome.json', 'cache.mjs', 'mutation.mjs', 'presentation.mjs', 'server.mjs']);
  assert(covered.manifest.entries.every(entry => entry.mode === '100644'));
  assert.deepEqual(covered.manifest.entries.filter(entry => entry.path !== 'biome.json'), baseline.manifest.entries);
  const biome = await readFile(new URL('../fixtures/authoring-benchmark/biome.json', import.meta.url), 'utf8');
  assert.equal(biome, JSON.stringify({ formatter: { enabled: false }, linter: { enabled: true, rules: { recommended: false, suspicious: { noDebugger: 'error' } } }, assist: { enabled: false } }, null, 2) + '\n');
  assert(covered.objects.some(object => object.type === 'blob' && Buffer.from(object.dataBase64, 'base64').toString() === biome));
  assert.equal(covered.manifest.entries[0]!.digest, covered.sourceDigests['fixtures/authoring-benchmark/biome.json']);
  assert.equal(Object.keys(covered.sourceDigests).length, 5); assert.equal(Object.keys(covered.objectDigests).length, 7);
  assert.notEqual(covered.candidate.commit, baseline.candidate.commit); assert.notEqual(covered.manifestDigest, baseline.manifestDigest);
  assert.deepEqual(covered.candidate, repeated.candidate); assert.deepEqual(covered.objectDigests, repeated.objectDigests);
});

async function ownedServer() {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-owned-seed-')), repoDir = join(directory, 'repo.git');
  const state = { created: false, visible: false, description: '', createCalls: 0, pushCalls: 0, loseCreate: false, losePush: false, pendingPush: null as Buffer | null, revoked: false, wrongAccount: false, oversized: false, denied: false, corruptUpload: false, corruptedPacks: 0, logOverride: '' };
  const paths: { method: string; path: string; gitProtocol: string }[] = [];
  const repoInfo = () => ({ id: 'owned-native-repo', name: config.repository, description: state.description, default_branch: 'main', read_only: false, remote: `https://${accountId}.artifacts.cloudflare.net/git/${config.artifactsNamespace}/${config.repository}.git` });
  async function nativeBackend(method: string, suffix: string, query: string, contentType: string, body: Buffer, gitProtocol = '') {
    // A CGI host must preserve Git-Protocol for both discovery and RPC calls.
    // Explicitly overwrite ambient values so protocol-v0 clones stay v0 too.
    const child = spawn('git', ['http-backend'], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_PROTOCOL: gitProtocol, HTTP_GIT_PROTOCOL: gitProtocol, GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: '/repo.git' + suffix, QUERY_STRING: query, REQUEST_METHOD: method, CONTENT_TYPE: contentType, CONTENT_LENGTH: String(body.length), SERVER_PROTOCOL: 'HTTP/1.1', REMOTE_USER: 'owned-test-user' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; child.stdout.on('data', data => chunks.push(data)); const diagnostics: Buffer[] = []; child.stderr.on('data', data => diagnostics.push(data));
    // exit can precede the final stdout data; close establishes complete output.
    const completion = new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Owned native Git backend failed'))); }); child.stdin.end(body); await completion;
    const output = Buffer.concat(chunks), split = output.indexOf('\r\n\r\n'); assert.ok(split > 0);
    const headers = new Headers(); let status = 200;
    for (const line of output.subarray(0, split).toString().split('\r\n')) { const colon = line.indexOf(':'); if (colon < 0) continue; if (line.slice(0, colon).toLowerCase() === 'status') status = Number.parseInt(line.slice(colon + 1), 10); else headers.set(line.slice(0, colon), line.slice(colon + 1).trim()); }
    return { status, headers, body: output.subarray(split + 4) };
  }
  const server = createServer(async (request: IncomingMessage, response) => {
    try {
      const url = new URL(request.url!, 'http://owned.test'), method = request.method!, path = url.pathname.replace(`/client/v4/accounts/${accountId}`, ''), gitProtocol = String(request.headers['git-protocol'] || ''); paths.push({ method, path, gitProtocol });
      const send = (result: unknown, status = 200, resultInfo?: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ code: 10000, message: apiToken + ' ' + repoToken }], ...(resultInfo ? { result_info: resultInfo } : {}) })); };
      if (url.pathname.startsWith('/client/v4/')) {
        assert.equal(request.headers.authorization, 'Bearer ' + apiToken);
        if (state.oversized) { response.writeHead(200); response.end(' '.repeat(1024 * 1024 + 1)); return; }
        if (state.denied) { send(null, 403); return; }
        if (path === '') { send({ id: state.wrongAccount ? '2'.repeat(32) : accountId }); return; }
        const namespace = `/artifacts/namespaces/${config.artifactsNamespace}`, repo = namespace + '/repos/' + config.repository;
        if (path === namespace) { send({ namespace: config.artifactsNamespace }); return; }
        if (path === repo && method === 'GET') { send(state.visible ? repoInfo() : null, state.visible ? 200 : 404); return; }
        if (path === namespace + '/repos' && method === 'POST') {
          state.createCalls++; assert.equal(state.created, false); let raw = ''; for await (const chunk of request) raw += chunk.toString(); const body = JSON.parse(raw); assert.equal(body.name, config.repository); assert.equal(body.default_branch, 'main'); state.description = body.description;
          // Match the provider's requested default branch rather than the host's
          // init.defaultBranch. Otherwise Linux can leave HEAD on unborn master.
          await run('git', ['-c', 'init.defaultBranch=owned-legacy-default', 'init', '--bare', '--initial-branch=main', '--object-format=sha1', repoDir]);
          assert.equal((await run('git', ['--git-dir', repoDir, 'symbolic-ref', 'HEAD'])).stdout.trim(), 'refs/heads/' + body.default_branch);
          await run('git', ['--git-dir', repoDir, 'config', 'http.receivepack', 'true']); state.created = true;
          if (state.loseCreate) { state.loseCreate = false; response.destroy(); return; }
          state.visible = true; send({ ...repoInfo(), token: repoToken }); return;
        }
        if (path === repo + '/log') { const head = state.logOverride || (await run('git', ['--git-dir', repoDir, 'rev-parse', 'refs/heads/main'])).stdout.trim(); send([{ hash: head }]); return; }
        if (path === repo + '/tokens') { send([{ id: 'owned-token-id', scope: 'write', state: state.revoked ? 'revoked' : 'active' }], 200, { total_pages: 1, total_count: 1 }); return; }
        if (path === namespace + '/tokens/owned-token-id' && method === 'DELETE') { state.revoked = true; send({ id: 'owned-token-id' }); return; }
        send(null, 404); return;
      }
      assert.equal(request.headers.authorization, 'Bearer ' + repoToken); assert.equal(state.revoked, false);
      const prefix = `/git/${config.artifactsNamespace}/${config.repository}.git`; assert.ok(url.pathname.startsWith(prefix));
      const suffix = url.pathname.slice(prefix.length), chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks);
      if (suffix === '/git-receive-pack') { state.pushCalls++; if (state.losePush) { state.losePush = false; state.pendingPush = body; response.destroy(); return; } }
      const result = await nativeBackend(method, suffix, url.search.slice(1), String(request.headers['content-type'] || ''), body, gitProtocol);
      if (state.corruptUpload && suffix === '/git-upload-pack') {
        // v2 ls-refs shares this endpoint but contains no object pack.
        const pack = result.body.indexOf('PACK');
        if (pack >= 0) { assert.ok(pack + 24 < result.body.length); result.body[pack + 24] ^= 0x40; state.corruptedPacks++; }
      }
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(result.body);
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address === 'object');
  const fetcher: typeof fetch = (input, init) => { const url = new URL(String(input)); assert.ok(url.origin === 'https://api.cloudflare.com' || url.origin === `https://${accountId}.artifacts.cloudflare.net`); return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init); };
  const options: SeedOptions = { run: true, useWrangler: true, fetcher, timeoutMs: 2000, credentialSelector: () => ({ account: accountId, credential: apiToken, checks: [{ name: 'owned-mocked-existing-oauth', status: 'PASS', detail: { scope: 'artifacts:write', mutationPerformed: false } }] }) };
  return { directory, state, paths, options, applyPending: async () => { assert.ok(state.pendingPush); await nativeBackend('POST', '/git-receive-pack', '', 'application/x-git-receive-pack-request', state.pendingPush); state.pendingPush = null; }, close: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); } };
}

test('owned bootstrap gates network, account identity, existing resources and arbitrary provider diagnostics', async () => {
  const owned = await ownedServer(); try {
    const path = join(owned.directory, 'plan.json');
    for (const artifactsNamespace of ['_invalid', 'x', '../outside']) await assert.rejects(seedPilot({ ...config, artifactsNamespace }, path, owned.options), /EXPLICIT_OWNED_SEED_TARGET_REQUIRED/);
    assert.equal(owned.paths.length, 0);
    assert.equal((await seedPilot(config, path, { ...owned.options, run: false })).status, 'BLOCKED'); assert.equal(owned.paths.length, 0);
    const deniedScope = await seedPilot(config, path, { ...owned.options, credentialSelector: () => ({ account: accountId, checks: [{ name: 'wrangler-account-and-artifacts-scope', status: 'BLOCKED', detail: { reason: 'WRANGLER_ARTIFACTS_SCOPE_REQUIRED' } }] }) });
    assert.equal(deniedScope.status, 'BLOCKED'); assert.equal(owned.paths.length, 0);
    owned.state.wrongAccount = true; assert.ok((await seedPilot(config, path, owned.options)).blockers.includes('API_ACCOUNT_MISMATCH')); assert.equal(owned.state.createCalls, 0); owned.state.wrongAccount = false;
    owned.state.visible = true; assert.ok((await seedPilot(config, path, owned.options)).blockers.includes('UNJOURNALED_EXISTING_REPOSITORY')); assert.equal(owned.state.createCalls, 0); owned.state.visible = false;
    owned.state.oversized = true; assert.ok((await seedPilot(config, path, owned.options)).blockers.includes('RESPONSE_SIZE_LIMIT')); owned.state.oversized = false;
    owned.state.denied = true; const denied = await seedPilot(config, path, owned.options); assert.deepEqual(denied.checks.at(-1)?.detail.apiCodes, [10000]); const report = await readFile(path, 'utf8'); assert.equal(report.includes(apiToken), false); assert.equal(report.includes(repoToken), false);
  } finally { await owned.close(); }
});

test('actual owned HTTP/native Git handles lost create and delayed lost push without repeating either mutation', async () => {
  const owned = await ownedServer(); try {
    const path = join(owned.directory, 'report.json'); owned.state.loseCreate = true;
    const lostCreate = await seedPilot(config, path, owned.options); assert.equal(lostCreate.create, 'UNKNOWN'); assert.equal(owned.state.createCalls, 1);
    const absent = await seedPilot(config, path, owned.options); assert.ok(absent.blockers.includes('CREATE_UNRESOLVED_RESOURCE_NOT_OBSERVED')); assert.equal(owned.state.createCalls, 1);
    owned.state.visible = true; const noToken = await seedPilot(config, path, owned.options); assert.ok(noToken.blockers.includes('PRIVATE_REPO_TOKEN_REQUIRED_FOR_RECONCILIATION')); assert.equal(owned.state.pushCalls, 0);
    const privatePath = join(owned.directory, 'provided.token'); await writeFile(privatePath, repoToken, { mode: 0o600 }); const withToken = { ...owned.options, repoTokenFile: privatePath }; owned.state.losePush = true;
    const lostPush = await seedPilot(config, path, withToken); assert.equal(lostPush.push, 'UNKNOWN'); assert.equal(owned.state.pushCalls, 1);
    const empty = await seedPilot(config, path, withToken); assert.ok(empty.blockers.includes('EMPTY_REF_DOES_NOT_PROVE_CANCELLATION')); assert.equal(owned.state.pushCalls, 1);
    await owned.applyPending(); const complete = await seedPilot(config, path, withToken); assert.equal(complete.status, 'PASS', JSON.stringify(complete.blockers)); assert.equal(complete.push, 'OBSERVED'); assert.ok(complete.rawSourceVerifiedAt); assert.equal(complete.credentialsRevoked, true); assert.equal(Object.keys(complete.objectDigests).length, 6); assert.equal(Object.keys(complete.sourceDigests).length, 4); assert.equal(owned.state.createCalls, 1); assert.equal(owned.state.pushCalls, 1);
    assert.ok(owned.paths.some(request => request.method === 'POST' && request.path.endsWith('/git-upload-pack') && request.gitProtocol === 'version=2'), 'Native CGI must handle the actual v2 ref lookup');
    assert.ok(owned.paths.some(request => request.method === 'POST' && request.path.endsWith('/git-upload-pack') && request.gitProtocol === ''), 'Native CGI must also handle the ordinary v0 clone');
    const repeat = await seedPilot(config, path, owned.options); assert.equal(repeat.status, 'PASS'); assert.equal(repeat.rawSourceVerifiedAt, complete.rawSourceVerifiedAt); assert.equal(owned.state.pushCalls, 1);
    owned.state.logOverride = 'f'.repeat(40); const moved = await seedPilot(config, path, owned.options); assert.ok(moved.blockers.includes('COMPLETED_SEED_HEAD_CHANGED')); assert.equal(owned.state.pushCalls, 1);
    const raw = await readFile(path, 'utf8'); assert.equal(raw.includes(apiToken), false); assert.equal(raw.includes(repoToken), false);
  } finally { await owned.close(); }
});

test('fresh seed raw-object roundtrip detects corrupted returned Git pack and retains uncertain admission', async () => {
  const owned = await ownedServer(); try {
    const source = await fixtureSource(); assert.equal(source.manifest.entries.length, 4); assert.ok(source.manifest.entries.every(entry => entry.mode === '100644')); owned.state.corruptUpload = true;
    const result = await seedPilot(config, join(owned.directory, 'corrupt.json'), owned.options); assert.equal(result.status, 'BLOCKED'); assert.equal(result.rawSourceVerifiedAt, null); assert.equal(result.credentialsRevoked, false); assert.equal(owned.state.pushCalls, 1); assert.equal(owned.state.corruptedPacks, 1, 'Failure must follow corruption of an actual returned Git pack');
  } finally { await owned.close(); }
});

test('invalid presets and changed preset journal pins fail before credential selection or provider requests', async () => {
  const owned = await ownedServer(); let credentialCalls = 0;
  const options = { ...owned.options, credentialSelector: () => { credentialCalls++; throw new Error('Credential selection must not run'); } };
  try {
    for (const fixtureProfile of [null, '', 'default', 'biome-covered', {}, []]) {
      await assert.rejects(seedPilot(config, join(owned.directory, 'invalid.json'), { ...options, fixtureProfile } as unknown as SeedOptions), /SEED_FIXTURE_PROFILE_INVALID/);
    }
    const baselinePath = join(owned.directory, 'baseline.json'), coveredPath = join(owned.directory, 'covered.json');
    await seedPilot(config, baselinePath, { ...options, run: false });
    await assert.rejects(seedPilot(config, baselinePath, { ...options, fixtureProfile: 'authoring-biome-v1' }), /SEED_INTENT_OR_SOURCE_CHANGED/);
    await seedPilot(config, coveredPath, { ...options, run: false, fixtureProfile: 'authoring-biome-v1' });
    await assert.rejects(seedPilot(config, coveredPath, options), /SEED_INTENT_OR_SOURCE_CHANGED/);
    const original = JSON.parse(await readFile(coveredPath, 'utf8'));
    const missingProfile = structuredClone(original); delete missingProfile.fixtureProfile;
    await writeFile(coveredPath, JSON.stringify(missingProfile));
    await assert.rejects(seedPilot(config, coveredPath, { ...options, fixtureProfile: 'authoring-biome-v1' }), /SEED_INTENT_OR_SOURCE_CHANGED/);
    const changedSource = structuredClone(original); changedSource.sourceDigests['fixtures/authoring-benchmark/biome.json'] = 'sha256:' + '0'.repeat(64);
    await writeFile(coveredPath, JSON.stringify(changedSource));
    await assert.rejects(seedPilot(config, coveredPath, { ...options, fixtureProfile: 'authoring-biome-v1' }), /SEED_INTENT_OR_SOURCE_CHANGED/);
    assert.equal(credentialCalls, 0); assert.equal(owned.paths.length, 0);
  } finally { await owned.close(); }
});

test('covered preset completes exact five-file native Git roundtrip and revokes bootstrap tokens without replaying mutations', async () => {
  const owned = await ownedServer();
  try {
    const path = join(owned.directory, 'covered.json'), options = { ...owned.options, fixtureProfile: 'authoring-biome-v1' as const };
    const source = await fixtureSource(options.fixtureProfile), result = await seedPilot(config, path, options);
    assert.equal(result.status, 'PASS', JSON.stringify(result.blockers)); assert.equal(result.fixtureProfile, 'authoring-biome-v1');
    assert.equal(result.expectedHead, source.candidate.commit); assert.equal(result.manifestDigest, source.manifestDigest);
    assert.deepEqual(result.sourceDigests, source.sourceDigests); assert.deepEqual(result.objectDigests, source.objectDigests);
    assert.equal(result.push, 'OBSERVED'); assert(result.rawSourceVerifiedAt); assert.equal(result.credentialsRevoked, true);
    assert.equal(Object.keys(result.sourceDigests).length, 5); assert.equal(Object.keys(result.objectDigests).length, 7);
    const returned = (await run('git', ['--git-dir', join(owned.directory, 'repo.git'), 'ls-tree', '-r', 'refs/heads/main'])).stdout.trim().split('\n');
    assert.deepEqual(returned.map(row => row.split('\t')[1]), source.manifest.entries.map(entry => entry.path));
    assert(returned.every(row => row.startsWith('100644 blob ')));
    const biome = (await run('git', ['--git-dir', join(owned.directory, 'repo.git'), 'show', 'refs/heads/main:biome.json'])).stdout;
    assert.equal(biome, await readFile(new URL('../fixtures/authoring-benchmark/biome.json', import.meta.url), 'utf8'));
    await assert.rejects(readFile(path + '.repo-token'), { code: 'ENOENT' });
    const repeated = await seedPilot(config, path, options); assert.equal(repeated.status, 'PASS'); assert.equal(repeated.rawSourceVerifiedAt, result.rawSourceVerifiedAt);
    const requests = owned.paths.length;
    await assert.rejects(seedPilot(config, path, owned.options), /SEED_INTENT_OR_SOURCE_CHANGED/); assert.equal(owned.paths.length, requests);
    assert.equal(owned.state.createCalls, 1); assert.equal(owned.state.pushCalls, 1);
    const report = await readFile(path, 'utf8'); assert(!report.includes(apiToken)); assert(!report.includes(repoToken));
  } finally { await owned.close(); }
});
