// SPDX-License-Identifier: Apache-2.0
import { COLLABORATION_OPERATIONS } from '../../packages/protocol/src/collaboration';
import { errorResponse, PlatformError, readBounded } from '../shared/errors';

/** Separate deployment capability profile, never a relaxation of protected release gates. */
export function collaborationPublicRoute(path: string): boolean {
  if (path === '/api/session' || path === '/api/projects') return true;
  const match = /^\/api\/projects\/[A-Za-z0-9_-]{1,128}(?:\/(.*))?$/.exec(path);
  if (!match) return false;
  const suffix = match[1];
  if (suffix === undefined || ['update', 'archive', 'restore', 'collaboration', 'join-requests', 'hub', 'hub/messages', 'hub/connections', 'hub/dependencies/weft', 'hub/dependencies/weft/bundle', 'agent/messages', 'agent/dependencies/weft', 'agent/dependencies/weft/bundle'].includes(suffix)) return true;
  if (/^hub\/connections\/[A-Za-z0-9_-]{1,128}\/revoke$/.test(suffix)) return true;
  return suffix === 'collaboration/inspect-invitation' || COLLABORATION_OPERATIONS.some(operation => suffix === `collaboration/${operation}`);
}

export function collaborationInternalRoute(path: string): boolean {
  return ['/internal/projects/list', '/internal/projects/get', '/internal/projects/create', '/internal/projects/command',
    '/internal/collaboration', '/internal/collaboration-command', '/internal/inspect-invitation',
    '/internal/join-requests', '/internal/request-join', '/internal/project-hub', '/internal/project-agent'].includes(path);
}

export function serveCollaborationApp(request: Request, maintenance: boolean, serve: () => Promise<Response>): Promise<Response> | Response {
  const path = new URL(request.url).pathname;
  if ((path.startsWith('/api/') || path.startsWith('/v1/')) && !collaborationPublicRoute(path))
    return errorResponse(new PlatformError('COLLABORATION_ONLY_DEPLOYMENT', 404));
  if (maintenance && (path.startsWith('/api/') || path.startsWith('/v1/')))
    return errorResponse(new PlatformError('COLLABORATION_SETUP_PENDING', 503));
  return serve();
}

export async function serveCollaborationAuthority(request: Request, serve: () => Promise<Response>): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!collaborationInternalRoute(path)) return errorResponse(new PlatformError('COLLABORATION_ONLY_DEPLOYMENT', 404));
  if (path === '/internal/projects/command') {
    try {
      const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(request.clone().body, 64 * 1024)));
      if (!['update', 'archive', 'restore'].includes(input?.command?.operation))
        return errorResponse(new PlatformError('COLLABORATION_ONLY_DEPLOYMENT', 404));
    } catch { return errorResponse(new PlatformError('INVALID_CONTROL_JSON', 400)); }
  }
  return serve();
}
