// SPDX-License-Identifier: Apache-2.0
import { parseProjectJson } from '../../packages/project-model/src/validation';
import { guardMutation, type Principal } from '../shared/auth';
import { readBounded, requireValue } from '../shared/errors';
import { authorityResponse } from './transport';

interface HubRouteEnv { APP_ORIGIN: string; APP_SERVICE_TOKEN: string; AUTHORITY: Fetcher; PROJECT_HUB_ENABLED?: string }
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const maximumBody = 64 * 1024;
async function body(request: Request): Promise<Record<string, unknown>> {
  requireValue(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'JSON_REQUIRED', 415);
  const value = parseProjectJson(await readBounded(request.body, maximumBody));
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'HUB_BODY_INVALID');
  return value as Record<string, unknown>;
}
function after(url: URL): string | undefined {
  requireValue([...url.searchParams.keys()].every(key => key === 'after') && url.searchParams.getAll('after').length <= 1, 'HUB_QUERY_INVALID');
  const value = url.searchParams.get('after');
  requireValue(value === null || /^(0|[1-9][0-9]{0,18})$/.test(value), 'HUB_QUERY_INVALID');
  return value ?? undefined;
}
function forward(env: HubRouteEnv, path: string, payload: unknown): Promise<Response> {
  return authorityResponse(env.AUTHORITY, `https://authority.internal${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${env.APP_SERVICE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }, 20_000, 2 * 1024 * 1024);
}

/** The only pre-JWT route. An opaque capability is validated inside the project authority. */
export async function agentHubRoute(request: Request, env: HubRouteEnv): Promise<Response | null> {
  const url = new URL(request.url), match = /^\/api\/projects\/([A-Za-z0-9_-]{1,128})\/agent\/(.*)$/.exec(url.pathname);
  if (!match) return null;
  requireValue(env.PROJECT_HUB_ENABLED === 'true' && url.origin === env.APP_ORIGIN, 'UNSUPPORTED_ROUTE', 404);
  const path = match[2];
  requireValue(['messages', 'dependencies/weft', 'dependencies/weft/bundle'].includes(path!), 'UNSUPPORTED_ROUTE', 404);
  requireValue(request.method === 'GET' || path === 'messages' && request.method === 'POST', 'METHOD_NOT_ALLOWED', 405);
  const origin = request.headers.get('origin'); requireValue(origin === null || origin === env.APP_ORIGIN, 'HUB_ORIGIN_DENIED', 403);
  const authorization = request.headers.get('authorization'), connectionId = request.headers.get('x-confidence-connection'), incarnation = request.headers.get('if-platform-incarnation');
  requireValue(authorization && /^Bearer [A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(authorization)
    && id(connectionId) && id(incarnation), 'HUB_CREDENTIAL_REQUIRED', 401);
  const cursor = path === 'messages' && request.method === 'GET' ? after(url) : undefined;
  if (cursor === undefined) requireValue(!url.search, 'HUB_QUERY_INVALID');
  const payload = { projectId: match[1], credentials: { projectId: match[1], projectIncarnation: incarnation, connectionId, token: authorization.slice(7) },
    operation: path === 'messages' ? request.method === 'GET' ? 'messages' : 'post' : 'dependency',
    ...(cursor === undefined ? {} : { after: cursor }), ...(request.method === 'POST' ? { body: await body(request) } : {}),
    ...(path!.startsWith('dependencies/') ? { bundle: path!.endsWith('/bundle') } : {}) };
  return forward(env, '/internal/project-agent', payload);
}

/** Normal Access authentication has already established the caller; membership remains authoritative. */
export async function humanHubRoute(request: Request, env: HubRouteEnv, principal: Principal): Promise<Response | null> {
  const url = new URL(request.url), match = /^\/api\/projects\/([A-Za-z0-9_-]{1,128})\/(hub(?:\/.*)?|join-requests)$/.exec(url.pathname);
  if (!match) return null;
  requireValue(env.PROJECT_HUB_ENABLED === 'true' && url.origin === env.APP_ORIGIN, 'UNSUPPORTED_ROUTE', 404);
  requireValue(principal.credentialClass === 'human', 'HUB_HUMAN_REQUIRED', 403);
  const expectedPrincipal = request.headers.get('if-platform-principal');
  requireValue(expectedPrincipal === null || expectedPrincipal === principal.id, 'SESSION_PRINCIPAL_CHANGED', 409);
  const caller = { principal, projectId: match[1] }, path = match[2]!;
  const incarnation = request.headers.get('if-platform-incarnation');
  requireValue(incarnation === null || id(incarnation), 'INVALID_EXPECTED_INCARNATION');
  if (request.method === 'POST') {
    guardMutation(request, principal, env);
    requireValue(expectedPrincipal === principal.id && id(incarnation), 'HUB_EXPECTED_CONTEXT_REQUIRED');
    requireValue(!url.search, 'HUB_QUERY_INVALID');
    const input = await body(request);
    if (path === 'join-requests') {
      const requestId = request.headers.get('idempotency-key'); requireValue(id(requestId), 'IDEMPOTENCY_KEY_REQUIRED');
      return forward(env, '/internal/request-join', { caller, request: { requestId, expectedIncarnation: incarnation, body: input } });
    }
    const revoke = /^hub\/connections\/([A-Za-z0-9_-]{1,128})\/revoke$/.exec(path);
    requireValue(path === 'hub/messages' || path === 'hub/connections' || revoke, 'UNSUPPORTED_ROUTE', 404);
    return forward(env, '/internal/project-hub', { caller, expectedIncarnation: incarnation,
      operation: revoke ? 'revoke' : path === 'hub/messages' ? 'post' : 'connect', body: input, ...(revoke ? { connectionId: revoke[1] } : {}) });
  }
  requireValue(request.method === 'GET', 'METHOD_NOT_ALLOWED', 405);
  if (path === 'join-requests') { requireValue(!url.search, 'HUB_QUERY_INVALID'); return forward(env, '/internal/join-requests', { caller }); }
  requireValue(['hub', 'hub/messages', 'hub/dependencies/weft', 'hub/dependencies/weft/bundle'].includes(path), 'UNSUPPORTED_ROUTE', 404);
  const cursor = path === 'hub' || path === 'hub/messages' ? after(url) : undefined;
  if (cursor === undefined) requireValue(!url.search, 'HUB_QUERY_INVALID');
  return forward(env, '/internal/project-hub', { caller, ...(incarnation === null ? {} : { expectedIncarnation: incarnation }),
    operation: path === 'hub' ? 'view' : path === 'hub/messages' ? 'messages' : 'dependency',
    ...(cursor === undefined ? {} : { after: cursor }), ...(path.startsWith('hub/dependencies/') ? { bundle: path.endsWith('/bundle') } : {}) });
}
