// SPDX-License-Identifier: Apache-2.0
import { IMPORTED_INVENTORY_BYTES, PROJECT_IMPORT_LIMITS } from '../../packages/project-model/src/types';
import { importedSourceRequest } from '../../packages/project-model/src/source';
import { parseProjectJson } from '../../packages/project-model/src/validation';
import { guardMutation, type AuthConfig, type Principal } from '../shared/auth';
import { readBounded, requireValue } from '../shared/errors';
import { MAX_CONTROL_BYTES } from '../shared/objects';
import { authorityResponse } from './transport';

interface ProjectRouteEnv extends AuthConfig {
  AUTHORITY: Fetcher; APP_SERVICE_TOKEN: string; DEFAULT_PROJECT_ID: string;
}

/** Resolve scoped native aliases without changing the authenticated project identity. */
export function projectApiScope(pathname: string, defaultProjectId: string): { projectId: string; pathname: string } {
  const match = /^\/api\/projects\/([a-zA-Z0-9_-]{1,128})\/(.+)$/.exec(pathname);
  requireValue(!pathname.startsWith('/api/projects/') || match, 'PROJECT_ROUTE_INVALID', 404);
  return match ? { projectId: match[1]!, pathname: `/api/${match[2]}` } : { projectId: defaultProjectId, pathname };
}

/** Metadata uses its own revision space; source imports never enter the signed control decoder. */
export async function projectManagementRoute(request: Request, env: ProjectRouteEnv, principal: Principal): Promise<Response | null> {
  const url = new URL(request.url);
  const source = /^\/api\/projects\/([a-zA-Z0-9_-]{1,128})\/source$/.exec(url.pathname);
  if (source) {
    requireValue(request.method === 'GET', 'METHOD_NOT_ALLOWED', 405);
    requireValue(principal.credentialClass === 'human', 'HUMAN_REQUIRED', 403);
    const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
    requireValue(url.origin === env.APP_ORIGIN && (origin === null || origin === env.APP_ORIGIN)
      && (site === null || site === 'same-origin' || site === 'none'), 'SOURCE_ORIGIN_DENIED', 403);
    const sourceRequest = importedSourceRequest(url.searchParams);
    return authorityResponse(env.AUTHORITY, 'https://authority.internal/internal/projects/source', {
      method: 'POST', headers: { authorization: `Bearer ${env.APP_SERVICE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ caller: { principal, projectId: source[1] }, sourceRequest }),
    }, 15_000, sourceRequest.view === 'tree' ? IMPORTED_INVENTORY_BYTES : PROJECT_IMPORT_LIMITS.archiveBytes);
  }
  const root = url.pathname === '/api/projects';
  const match = /^\/api\/projects\/([a-zA-Z0-9_-]{1,128})(?:\/(update|archive|restore|checks|import|cancel-import))?$/.exec(url.pathname);
  if (!root && !match) return null;
  requireValue(!url.search, 'PROJECT_QUERY_INVALID');
  requireValue(principal.credentialClass === 'human', 'HUMAN_REQUIRED', 403);
  const forward = (operation: string, body: unknown) => authorityResponse(env.AUTHORITY,
    `https://authority.internal/internal/projects/${operation}`, {
      method: 'POST', headers: { authorization: `Bearer ${env.APP_SERVICE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  if (request.method === 'GET') {
    requireValue(root || !match![2], 'METHOD_NOT_ALLOWED', 405);
    return root ? forward('list', { principal, defaultProjectId: env.DEFAULT_PROJECT_ID })
      : forward('get', { caller: { principal, projectId: match![1] } });
  }
  requireValue(request.method === 'POST' && (root || match![2]), 'METHOD_NOT_ALLOWED', 405);
  guardMutation(request, principal, env);
  const commandId = request.headers.get('idempotency-key');
  requireValue(commandId && /^[a-zA-Z0-9_-]{1,128}$/.test(commandId), 'IDEMPOTENCY_KEY_REQUIRED');
  const operation = match?.[2];
  const body = parseProjectJson(await readBounded(request.body, operation === 'import' ? PROJECT_IMPORT_LIMITS.archiveBytes : MAX_CONTROL_BYTES));
  if (root) return forward('create', { principal, command: { commandId, body } });
  const expectedRevision = request.headers.get('if-platform-revision');
  const expectedIncarnation = request.headers.get('if-platform-incarnation');
  requireValue(expectedRevision && /^(0|[1-9][0-9]{0,19})$/.test(expectedRevision), 'EXPECTED_REVISION_REQUIRED');
  requireValue(expectedIncarnation && /^[a-zA-Z0-9_-]{1,128}$/.test(expectedIncarnation), 'EXPECTED_INCARNATION_REQUIRED');
  return forward('command', { caller: { principal, projectId: match![1] }, command: { commandId, expectedRevision, expectedIncarnation, operation, body } });
}
