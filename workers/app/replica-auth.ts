// SPDX-License-Identifier: Apache-2.0

/** Credential surface selection only; authority still checks workspace, route and membership. */
export function isWeftReplicaRequest(request: Request, applicationOrigin: string): boolean {
  const url = new URL(request.url);
  const match = /^\/api\/projects\/[A-Za-z0-9_-]{1,128}\/weft\/api\/workspaces\/[A-Za-z0-9_-]{1,128}\/([A-Za-z0-9_/-]{1,240})$/.exec(url.pathname);
  return Boolean(url.origin === applicationOrigin && !url.search && match && match[1]!.split('/').every(segment => segment.length > 0)
    && (request.method === 'GET' || request.method === 'POST'));
}
