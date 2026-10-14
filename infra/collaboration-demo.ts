// SPDX-License-Identifier: Apache-2.0
// TEST ONLY. Synthetic identities and ephemeral state; never deploy this server.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collaborationRuntime } from './collaboration-runtime.ts';
import { sha256 } from '../packages/protocol/src/index.ts';
import { invitationDigestInput, type CollaborationRole, type CollaborationView } from '../packages/protocol/src/collaboration.ts';

const personas = ['owner', 'contributor', 'reviewer', 'successor'] as const;
type Persona = typeof personas[number];
type DemoRuntime = Awaited<ReturnType<typeof collaborationRuntime>>;
type Session = { persona: Persona; token: string; expiresAt: number };
const sessions = new Map<string, Session>();
const sessionCookie = 'confidence_local_demo';
const sessionDuration = 3600;
let runtime: DemoRuntime | undefined;
let origin = '';
let stopping = false;
const readyDemo = process.argv.includes('--ready-demo');
if (process.argv.slice(2).some(argument => argument !== '--ready-demo')) throw new Error('Usage: node --import tsx infra/collaboration-demo.ts [--ready-demo]');
await access(resolve('apps/web/dist/index.html')).catch(() => { throw new Error('Build the frontend first with npm run build:web.'); });

const privateHeaders = {
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
};
function reply(response: ServerResponse, status: number, text: string, headers: Record<string, string> = {}) {
  response.writeHead(status, { ...privateHeaders, 'content-type': 'text/plain; charset=utf-8', ...headers }); response.end(text);
}
function escapeHTML(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
function cookie(request: IncomingMessage): string | undefined {
  const matches = (request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(sessionCookie + '='));
  if (matches.length !== 1) return undefined;
  const value = matches[0]!.slice(sessionCookie.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
function session(request: IncomingMessage): Session | undefined {
  for (const [key, value] of sessions) if (value.expiresAt <= Date.now()) sessions.delete(key);
  return sessions.get(cookie(request) ?? '');
}
async function body(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maximum) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
function chooser(current?: Session): string {
  const descriptions: Record<Persona, string> = {
    owner: 'Configured bootstrap administrator; establish verified ownership, then manage access.',
    contributor: 'Accept a Contributor invitation and work with explicitly assigned attempt grants.',
    reviewer: 'Accept a Reviewer invitation and exercise protected review permissions.',
    successor: 'Accept an Owner invitation before the current owner can transfer responsibility.',
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>Confidence local collaboration demo</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#18252a;font:16px/1.5 system-ui,sans-serif}main{max-width:940px;margin:0 auto;padding:32px 20px}h1{font-size:28px;margin:0 0 12px}h2{font-size:19px;margin:0 0 8px}p{margin:0 0 16px}.flag{display:inline-block;font-size:13px;font-weight:700;color:#8b273a;background:#fce8ed;padding:3px 8px;border-radius:3px;margin-bottom:12px}.sessions{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px;margin:24px 0}form.persona{background:#fff;border:1px solid #cbd4d8;border-radius:6px;padding:18px}button,a.button{display:inline-block;border:1px solid #1b6856;background:#1b6856;color:#fff;border-radius:4px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}a{color:#1b6856}code{overflow-wrap:anywhere;font-size:13px}.identity{border-top:1px solid #cbd4d8;padding-top:18px}.small{font-size:14px;color:#42565e}.actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
    </style></head><body><main><span class="flag">Local test environment</span><h1>Confidence collaboration</h1><p>This loopback-only rehearsal uses synthetic people and a local signing key. Production JWT verification, Application Worker and SQLite authority run in workerd. It does not connect to a real identity provider, send invitations or publish repositories.</p><p class="small">Choose a test person, then open the project. Use separate browser profiles for simultaneous people, or return here to switch. To accept an invitation, select its intended person first and then open the private invitation link.</p>
    <div class="sessions">${personas.map(persona => `<form class="persona" method="post" action="/_demo/login"><h2>${persona[0]!.toUpperCase() + persona.slice(1)}</h2><p class="small">${descriptions[persona]}</p><p><code>${escapeHTML(runtime!.issuer)}#${persona}</code></p><input type="hidden" name="persona" value="${persona}"><button type="submit">Continue as ${persona}</button></form>`).join('')}</div>
    <div class="identity"><p>Current test person: <strong>${current ? escapeHTML(current.persona) : 'None selected'}</strong></p><div class="actions"><a class="button" href="/#/collaboration">Open project access</a>${current ? '<form method="post" action="/_demo/logout"><button type="submit">Clear local session</button></form>' : ''}</div></div><p class="small" style="margin-top:20px">Sessions and invitation delivery secrets stay in memory. Restarting this demo creates a new project and signing key. Selecting a person again issues a fresh token; it is not a real human authentication ceremony.</p></main></body></html>`;
}

const server = createServer((request, response) => { void handle(request, response); });
async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (!origin || request.headers.host !== new URL(origin).host) { reply(response, 403, 'Use the loopback URL printed by this demo.'); return; }
    const url = new URL(request.url ?? '/', origin);
    if (url.origin !== origin) { reply(response, 403, 'Origin unavailable.'); return; }
    let decoded: string;
    try { decoded = decodeURIComponent(url.pathname); } catch { reply(response, 400, 'Invalid request path.'); return; }
    if (decoded.startsWith('/_test') || decoded.startsWith('/internal') || decoded.includes('\\')) { reply(response, 404, 'Not found.'); return; }
    if (!runtime) { reply(response, 503, 'The local test runtime is preparing.'); return; }
    if (url.pathname === '/_demo' || url.pathname === '/_demo/') {
      if (request.method !== 'GET' && request.method !== 'HEAD') { reply(response, 405, 'Method not allowed.'); return; }
      reply(response, 200, request.method === 'HEAD' ? '' : chooser(session(request)), {
        'content-type': 'text/html; charset=utf-8',
        'referrer-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      }); return;
    }
    if (url.pathname === '/_demo/login' || url.pathname === '/_demo/logout') {
      if (request.method !== 'POST') { reply(response, 405, 'Method not allowed.'); return; }
      if (request.headers.origin !== origin || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) { reply(response, 403, 'A same-origin form submission is required.'); return; }
      if (url.search) { reply(response, 400, 'Query parameters are unavailable.'); return; }
      const oldSession = cookie(request);
      if (url.pathname === '/_demo/logout') {
        if (oldSession) sessions.delete(oldSession);
        reply(response, 303, '', { location: '/_demo', 'set-cookie': `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` }); return;
      }
      if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') { reply(response, 415, 'A form is required.'); return; }
      const form = new URLSearchParams((await body(request, 1024)).toString('utf8'));
      const persona = form.get('persona');
      if (Array.from(form.keys()).join(',') !== 'persona' || !personas.some(value => value === persona)) { reply(response, 400, 'Choose one listed test person.'); return; }
      const signed = await runtime.token(persona!, { iat: Math.floor(Date.now() / 1000) });
      if (oldSession) sessions.delete(oldSession);
      session(request);
      while (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
      const id = randomBytes(32).toString('base64url');
      sessions.set(id, { persona: persona as Persona, token: signed, expiresAt: Date.now() + sessionDuration * 1000 });
      reply(response, 303, '', { location: '/#/collaboration', 'set-cookie': `${sessionCookie}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDuration}` }); return;
    }
    if (decoded.startsWith('/_demo')) { reply(response, 404, 'Not found.'); return; }
    const current = session(request);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || ['authorization', 'cf-access-jwt-assertion', 'cookie', 'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'expect'].includes(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    if (current) headers.set('authorization', `Bearer ${current.token}`);
    const data = request.method === 'GET' || request.method === 'HEAD' ? undefined : await body(request, 8 * 1024 * 1024 + 65536);
    const upstream = await runtime.fetch(url.pathname + url.search, { method: request.method, headers, ...(data ? { body: new Uint8Array(data).buffer } : {}) });
    const output: Record<string, string> = { ...privateHeaders };
    upstream.headers.forEach((value, name) => { if (!['transfer-encoding', 'connection', 'set-cookie'].includes(name)) output[name] = value; });
    response.writeHead(upstream.status, output);
    if (request.method !== 'HEAD' && upstream.body) for await (const chunk of upstream.body) response.write(chunk);
    response.end();
  } catch (error) {
    if (response.headersSent) { response.end(); return; }
    reply(response, error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? 413 : 503, 'The local test request could not be completed.');
  }
}

async function prepareDemo(value: DemoRuntime): Promise<void> {
  const tokens = new Map<Persona, string>();
  for (const persona of ['owner', 'contributor', 'reviewer'] as const) tokens.set(persona, await value.token(persona));
  async function view(): Promise<CollaborationView> {
    const response = await value.fetch('/api/collaboration', { headers: { authorization: 'Bearer ' + tokens.get('owner') } });
    if (!response.ok) throw new Error('DEMO_MEMBERSHIP_READ_FAILED');
    return response.json() as Promise<CollaborationView>;
  }
  async function command(persona: Persona, operation: string, data: unknown) {
    const revision = operation === 'accept-invitation' ? '0' : (await view()).revision;
    const response = await value.fetch('/api/collaboration/' + operation, { method: 'POST', headers: {
      authorization: 'Bearer ' + tokens.get(persona), origin: value.origin, 'content-type': 'application/json', 'x-platform-csrf': '1',
      'idempotency-key': randomUUID(), 'if-platform-principal': value.issuer + '#' + persona, 'if-platform-revision': revision,
      'if-platform-incarnation': value.scope.projectIncarnation,
    }, body: JSON.stringify(data) });
    if (!response.ok) throw new Error(`DEMO_${operation.toUpperCase().replaceAll('-', '_')}_FAILED_${response.status}`);
    await response.body?.cancel();
  }
  await command('owner', 'enable-collaboration', {});
  for (const [persona, role] of [['contributor', 'contributor'], ['reviewer', 'reviewer']] as [Persona, CollaborationRole][]) {
    const invitationId = randomUUID(), token = randomBytes(32).toString('base64url');
    await command('owner', 'create-invitation', { invitationId, recipientId: value.issuer + '#' + persona, role,
      tokenDigest: await sha256(invitationDigestInput(value.scope, invitationId, token)), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    await command(persona, 'accept-invitation', { invitationId, token });
  }
}

async function listen(port: number): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    const failed = (error: Error) => { server.off('listening', opened); reject(error); };
    const opened = () => { server.off('error', failed); resolveListen(); };
    server.once('error', failed); server.once('listening', opened); server.listen(port, '127.0.0.1');
  });
}
async function stop(): Promise<void> {
  if (stopping) return; stopping = true;
  sessions.clear(); server.closeAllConnections();
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  await runtime?.dispose();
}
try {
  for (let port = 8791; port <= 8801; port++) {
    try { await listen(port); origin = `http://127.0.0.1:${port}`; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 8801) throw error; }
  }
  runtime = await collaborationRuntime(origin);
  if (readyDemo) await prepareDemo(runtime);
  process.stdout.write(JSON.stringify({ status: 'READY', url: `${origin}/_demo`, readyDemo, environment: 'local-test-only-synthetic-identities' }) + '\n');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop().then(() => process.exit(0), () => process.exit(1)); });
} catch (error) {
  await stop();
  throw error;
}
