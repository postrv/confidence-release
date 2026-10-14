import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentClient, isolatedGitEnvironment, parseConnection, readConnection, validateDependency, WEFT_DEPENDENCY } from './confidence-agent.mjs';

const connection = { schemaVersion: 1, origin: 'https://confidence.example', projectId: 'project', projectIncarnation: 'incarnation', connectionId: 'connection', token: Buffer.alloc(32, 7).toString('base64url') };
test('connection files require canonical HTTPS origins, bounded identifiers, and exactly a scoped token', () => {
  assert.deepEqual(parseConnection(connection), connection);
  for (const patch of [{ origin: 'http://localhost' }, { origin: 'https://confidence.example/path' }, { origin: 'https://user:pass@confidence.example' }, { origin: 'https://confidence.example/' }, { projectId: '../other' }, { token: 'x'.repeat(43) }, { schemaVersion: 2 }, { accessToken: 'human-jwt' }]) assert.throws(() => parseConnection({ ...connection, ...patch }));
});
test('connection reader rejects public credentials and accepts owner-only files', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'confidence-agent-'));
  try {
    const path = join(folder, 'connection.json');
    await writeFile(path, JSON.stringify(connection), { mode: 0o600 });
    assert.deepEqual(await readConnection(path), connection);
    await chmod(path, 0o644);
    await assert.rejects(readConnection(path), /chmod 600/);
    await chmod(path, 0o600);
    await writeFile(path, `${connection.token} this is malformed private JSON`);
    await assert.rejects(readConnection(path), error => error.message === 'Connection file is not valid JSON.' && !error.message.includes(connection.token));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test('agent transport has exact destinations, no redirects or ambient browser credentials', async () => {
  const calls = [];
  const client = createAgentClient(connection, async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ scope: { projectId: connection.projectId, projectIncarnation: connection.projectIncarnation }, messages: [], nextCursor: '12', hasMore: false });
  });
  await client.read('12');
  await client.post({ requestId: 'same-request', text: 'hello', kind: 'message' });
  assert.equal(calls[0].url, 'https://confidence.example/api/projects/project/agent/messages?after=12');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${connection.token}`);
  assert.equal(calls[0].init.headers['if-platform-incarnation'], 'incarnation');
  assert.equal(calls[0].init.headers['x-confidence-connection'], 'connection');
  assert.equal(calls[0].init.headers['CF-Access-Token'], undefined);
  await assert.rejects(client.read('../other'));
  await assert.rejects(client.post({ requestId: 'same-request', text: 'hello', kind: 'approval' }));
  assert.equal(calls.length, 2);
});
test('agent discussion reads reject a different project or incarnation', async () => {
  for (const scope of [{ projectId: 'other', projectIncarnation: connection.projectIncarnation }, { projectId: connection.projectId, projectIncarnation: 'replaced' }]) {
    const client = createAgentClient(connection, async () => Response.json({ scope, messages: [], nextCursor: '0', hasMore: false }));
    await assert.rejects(client.read(), /different project/);
  }
});
test('post retry preserves explicit identity and inputs; response errors never echo tokens', async () => {
  const bodies = []; let fail = true;
  const client = createAgentClient(connection, async (_url, init) => {
    bodies.push(init.body);
    if (fail) { fail = false; throw new Error(`secret ${connection.token}`); }
    return Response.json({ error: { message: connection.token } }, { status: 403 });
  });
  const message = { requestId: 'retry-id', kind: 'handoff', text: 'Frozen context' };
  await assert.rejects(client.post(message), error => !error.message.includes(connection.token));
  await assert.rejects(client.post(message), /HTTP 403/);
  assert.equal(bodies[0], bodies[1]);
});
test('dependency verification rejects any changed pin or size', () => {
  assert.deepEqual(validateDependency(structuredClone(WEFT_DEPENDENCY)), WEFT_DEPENDENCY);
  for (const patch of [{ commit: 'f'.repeat(40) }, { tree: 'f'.repeat(40) }, { bundle: { ...WEFT_DEPENDENCY.bundle, sha256: 'f'.repeat(64) } }, { bundle: { ...WEFT_DEPENDENCY.bundle, bytes: 1 } }]) assert.throws(() => validateDependency({ ...WEFT_DEPENDENCY, ...patch }));
});
test('Git verification excludes every ambient GIT variable before setting controlled configuration', () => {
  const env = isolatedGitEnvironment('/empty-hooks', { PATH: '/usr/bin', GIT_OBJECT_DIRECTORY: '/untrusted', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/untrusted', GIT_COMMON_DIR: '/untrusted', GIT_REPLACE_REF_BASE: 'refs/untrusted/', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.sshCommand', GIT_CONFIG_VALUE_0: 'untrusted', GIT_FUTURE_SWITCH: 'untrusted' });
  assert.equal(env.PATH, '/usr/bin');
  assert.deepEqual(Object.keys(env).filter(key => key.startsWith('GIT_')).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TEMPLATE_DIR']);
  assert.equal(env.GIT_CONFIG_COUNT, '0');
  assert.equal(env.GIT_TEMPLATE_DIR, '/empty-hooks');
});
test('bundle acquisition checks complete bytes and hash before invoking Git', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'confidence-agent-'));
  try {
    const client = createAgentClient(connection, async url => String(url).endsWith('/bundle') ? new Response('tampered') : Response.json(WEFT_DEPENDENCY));
    await assert.rejects(client.fetchWeft(join(folder, 'weft')), /bundle identity/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('rejected response cleanup cancels the body without blocking credential refusal', { timeout: 1000 }, async () => {
  let cancelled = 0;
  const client = createAgentClient(connection, async () => new Response(new ReadableStream({
    cancel() { cancelled++; return new Promise(() => {}); },
  }), { status: 403 }));
  await assert.rejects(client.read(), /HTTP 403/);
  assert.equal(cancelled, 1, 'an unread failure body must be cancelled even if cleanup stalls');
});
