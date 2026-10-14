import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { LocalPlatform } from './platform.ts';
import { LocalProjects } from './projects.ts';
import { PROJECT_IMPORT_LIMITS, type ProjectMetadataCommand } from '../packages/project-model/src/types.ts';
import { importedSourceRequest } from '../packages/project-model/src/source.ts';
import { parseProjectJson } from '../packages/project-model/src/validation.ts';
import { PlatformError, requireValue } from '../workers/shared/errors.ts';
import { getKernel, verifyBundle } from '../packages/protocol/src/index.ts';
export async function boundedBody(request: http.IncomingMessage, maximum: number): Promise<string> {
  if (Number(request.headers['content-length'] || 0) > maximum) throw new Error('BODY_LIMIT');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maximum) throw new Error('BODY_LIMIT'); chunks.push(Buffer.from(chunk)); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new PlatformError('INVALID_CONTROL_JSON', 400); }
}
export async function startServer(options: { port?: number; dataDir?: string; host?: string } = {}) {
  if (options.host && !['127.0.0.1', 'localhost'].includes(options.host)) throw new Error('LOCAL_SERVER_REQUIRES_LOOPBACK_HOST');
  const platform = new LocalPlatform(options.dataDir); await platform.initialize();
  const projects = new LocalProjects(platform); await projects.initialize();
  const session = randomBytes(32).toString('hex'); const sockets = new Set<http.ServerResponse>();
  const json = (response: http.ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)); };
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = http.createServer(async (request, response) => {
    try {
      const port = (server.address() as any)?.port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host || '')) { json(response, 403, { error: 'HOST_DENIED' }); return; }
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      let path = url.pathname;
      if (path.startsWith('/api/')) {
        if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) { json(response, 403, { error: 'ORIGIN_DENIED' }); return; }
        if (request.headers['sec-fetch-site'] === 'cross-site') { json(response, 403, { error: 'ORIGIN_DENIED' }); return; }
        const expectedPrincipal = request.headers['if-platform-principal'];
        requireValue(expectedPrincipal === undefined || expectedPrincipal === 'local-pilot', 'SESSION_PRINCIPAL_CHANGED', 409);
        const management = /^\/api\/projects(?:\/([a-zA-Z0-9_-]{1,128})(?:\/(update|archive|restore|checks|import|cancel-import))?)?$/.exec(path);
        const scoped = /^\/api\/projects\/([a-zA-Z0-9_-]{1,128})\/(.+)$/.exec(path);
        const selectedProjectId = scoped?.[1] ?? platform.state.projectId;
        if (!management && scoped) path = `/api/${scoped[2]}`;
        if (request.method === 'GET') {
          response.setHeader('set-cookie', `confidence_local=${session}; HttpOnly; SameSite=Strict; Path=/`);
          if (management) {
            requireValue(!url.search && !management[2], 'PROJECT_QUERY_INVALID');
            json(response, 200, management[1] ? projects.get(management[1]) : projects.list()); return;
          }
          if (path === '/api/session') { json(response, 200, { principalId: 'local-pilot', credentialClass: 'human' }); return; }
          if (scoped && path === '/api/source') {
            const result = await projects.readSource(selectedProjectId, importedSourceRequest(url.searchParams));
            response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer())); return;
          }
          projects.assertNative(selectedProjectId, false);
          if (path === '/api/health') { json(response, 200, { ready: true, adapter: 'local-development', projectId: platform.state.projectId }); return; }
          if (path === '/api/state') { json(response, 200, platform.snapshot()); return; }
          if (path === '/api/trust-config') { response.setHeader('content-disposition', 'attachment; filename="confidence-trust.json"'); json(response, 200, platform.trustConfig()); return; }
          if (path === '/api/checkpoint') { json(response, 200, JSON.parse(await readFile(join(platform.directory, 'checkpoint.json'), 'utf8'))); return; }
          if (path === '/api/checkpoint-attestation') { json(response, 200, await platform.checkpointAttestation()); return; }
          if (path === '/api/events') {
            response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); sockets.add(response);
            const since = Number(request.headers['last-event-id'] || url.searchParams.get('since') || 0);
            for (const event of platform.state.events.filter(e => e.sequence > since)) response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
            request.on('close', () => sockets.delete(response)); return;
          }
          const receiptExport = /^\/api\/receipts\/([a-z0-9-]+)\/export$/.exec(path) || /^\/api\/bundles\/([a-z0-9-]+)$/.exec(path);
          if (receiptExport) { response.setHeader('content-disposition', `attachment; filename="${receiptExport[1]}.json"`); json(response, 200, await platform.exportReceipt(receiptExport[1])); return; }
          const receipt = /^\/api\/receipts\/([a-z0-9-]+)$/.exec(path);
          if (receipt) { const value = platform.state.receipts.find(r => r.id === receipt[1]); json(response, value ? 200 : 404, value || { error: 'RECEIPT_NOT_FOUND' }); return; }
          const sourceView = /^\/api\/candidates\/([a-z0-9-]+)\/source$/.exec(path);
          if (sourceView) { json(response, 200, await platform.candidateSource(sourceView[1], (url.searchParams.get('version') ?? 'candidate') as 'candidate' | 'base')); return; }
          const sourceBundle = /^\/api\/candidates\/([a-z0-9-]+)\/git-bundle$/.exec(path);
          if (sourceBundle && platform.state.candidates.some(c => c.id === sourceBundle[1])) { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${sourceBundle[1]}.gitbundle"` }); response.end(await readFile(join(platform.directory, 'bundles', sourceBundle[1] + '.gitbundle'))); return; }
          json(response, 404, { error: 'NOT_FOUND' }); return;
        }
        if (request.method !== 'POST') { json(response, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
        const cookie = request.headers.cookie || '';
        // Browser commands require the local session; explicit CLI clients have
        // loopback-only access. Neither is advertised as a production identity.
        if (!cookie.includes(`confidence_local=${session}`) && request.headers['x-confidence-local-client'] !== 'cli') { json(response, 401, { error: 'LOCAL_SESSION_REQUIRED' }); return; }
        if (request.headers['x-confidence-local-client'] !== 'cli' && request.headers['x-platform-csrf'] !== '1') { json(response, 403, { error: 'CSRF_HEADER_REQUIRED' }); return; }
        if (!String(request.headers['content-type']).startsWith('application/json')) { json(response, 415, { error: 'JSON_REQUIRED' }); return; }
        if (management) {
          requireValue(!url.search && (!management[1] || management[2]), 'UNSUPPORTED_ROUTE', 404);
          const commandId = request.headers['idempotency-key'];
          requireValue(typeof commandId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(commandId), 'IDEMPOTENCY_KEY_REQUIRED');
          const body = parseProjectJson(await boundedBody(request, management[2] === 'import' ? PROJECT_IMPORT_LIMITS.archiveBytes : 256 * 1024));
          if (!management[1]) { json(response, 201, await projects.create({ commandId, body: body as { name: string; description?: string } })); return; }
          const expectedRevision = request.headers['if-platform-revision'], expectedIncarnation = request.headers['if-platform-incarnation'];
          requireValue(typeof expectedRevision === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(expectedRevision), 'EXPECTED_REVISION_REQUIRED');
          requireValue(typeof expectedIncarnation === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(expectedIncarnation), 'EXPECTED_INCARNATION_REQUIRED');
          const result = await projects.command(management[1], { commandId, expectedRevision, expectedIncarnation, operation: management[2] as ProjectMetadataCommand['operation'], body });
          json(response, 200, result); return;
        }
        const raw = await boundedBody(request, path === '/api/verify' ? 8 * 1024 * 1024 : 256 * 1024);
        const body = JSON.parse(getKernel().canonical_json(raw || '{}'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('BODY_OBJECT_REQUIRED');
        const allowed: Record<string, string[]> = { '/api/demo': ['mode', 'autoSelect', 'commandId'], '/api/continue': ['contextCapsuleId', 'contextCapsuleDigest', 'workBase', 'sessionEntry', 'commandId'], '/api/select': ['attemptIds', 'commandId'], '/api/repair': ['conflictId', 'commandId'], '/api/review': ['candidateId', 'commandId'], '/api/approve': ['proposalDigest', 'commandId'], '/api/publish': ['proposalDigest', 'commandId', 'simulateLostResponse'], '/api/reconcile': ['commandId'], '/api/verify': ['bundle', 'trustConfig', 'checkpoint'] };
        if (!allowed[path] || Object.keys(body).some(key => !allowed[path].includes(key))) throw new Error('UNKNOWN_REQUEST_FIELD');
        if (path === '/api/demo' && body.mode !== undefined && !['scripted', 'pi'].includes(body.mode)) throw new Error('AGENT_MODE_INVALID');
        if (path === '/api/demo' && body.autoSelect !== undefined && typeof body.autoSelect !== 'boolean') throw new Error('AUTO_SELECT_BOOLEAN_REQUIRED');
        if (path === '/api/select' && (!Array.isArray(body.attemptIds) || body.attemptIds.some((entry: unknown) => typeof entry !== 'string'))) throw new Error('ATTEMPT_IDS_REQUIRED');
        if (path === '/api/publish' && body.simulateLostResponse !== undefined && typeof body.simulateLostResponse !== 'boolean') throw new Error('FAULT_FLAG_BOOLEAN_REQUIRED');
        const commandId = body.commandId || request.headers['idempotency-key'] || `command-${randomUUID()}`;
        if (path !== '/api/verify') projects.assertNative(selectedProjectId, true);
        let result: unknown;
        if (path === '/api/demo') result = await platform.startDemo({ ...body, commandId });
        else if (path === '/api/continue') result = await platform.continueAttempt({ ...body, commandId });
        else if (path === '/api/select') result = await platform.select({ ...body, commandId });
        else if (path === '/api/repair') result = await platform.repair({ ...body, commandId });
        else if (path === '/api/review') result = await platform.review({ ...body, commandId });
        else if (path === '/api/approve') result = await platform.approve({ ...body, commandId });
        else if (path === '/api/publish') result = await platform.publish({ ...body, commandId });
        else if (path === '/api/reconcile') result = await platform.reconcile({ commandId });
        else if (path === '/api/verify') result = verifyBundle(body.bundle, body.trustConfig, body.checkpoint || null);
        else { json(response, 404, { error: 'NOT_FOUND' }); return; }
        json(response, path === '/api/verify' ? 200 : 202, result); return;
      }
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      if (path.startsWith('/protocol/')) {
        const filename = path.slice('/protocol/'.length); if (!['confidence_protocol.js', 'confidence_protocol_bg.wasm'].includes(filename)) { response.writeHead(404).end(); return; }
        response.writeHead(200, { 'content-type': filename.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' }); response.end(await readFile(join(root, 'packages/protocol/wasm', filename))); return;
      }
      const distribution = join(root, 'apps/web/dist'), relative = path.replace(/^\//, '') || 'index.html';
      let filename = resolve(distribution, relative); if (!filename.startsWith(distribution + '/')) { response.writeHead(403).end(); return; }
      try { if (!(await stat(filename)).isFile()) filename = join(distribution, 'index.html'); } catch { filename = join(distribution, 'index.html'); }
      try {
        const body = await readFile(filename); const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png' };
        response.writeHead(200, { 'content-type': mime[extname(filename)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' }); response.end(body);
      } catch { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Confidence</title><p>Local API is ready. Build the interface with npm run build:web, then reload.</p>'); }
    } catch (error) { json(response, error instanceof PlatformError ? error.status : /NOT_FOUND/.test(String(error)) ? 404 : /BODY_LIMIT/.test(String(error)) ? 413 : 409, { error: String((error as Error).message), retry: 'Refresh authoritative state; reuse a command ID only for the identical request.' }); }
  });
  platform.on('event', event => { for (const response of sockets) response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`); });
  const heartbeat = setInterval(() => { for (const response of sockets) response.write(': keepalive\n\n'); }, 15000); heartbeat.unref();
  await new Promise<void>(resolveListen => server.listen(options.port ?? Number(process.env.PORT || 8787), options.host || '127.0.0.1', resolveListen));
  const port = (server.address() as any).port;
  return { server, platform, projects, port, close: async () => { clearInterval(heartbeat); for (const response of sockets) response.end(); await platform.shutdown(); server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = (flag: string) => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
  const running = await startServer({ port: value('--port') ? Number(value('--port')) : undefined, dataDir: value('--data-dir') ? resolve(value('--data-dir')!) : undefined });
  process.stdout.write(`Confidence local development server: http://127.0.0.1:${running.port}\n`);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void running.close().then(() => process.exit(0)));
}
