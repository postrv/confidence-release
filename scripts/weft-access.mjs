// SPDX-License-Identifier: Apache-2.0
// Preload with node --import when using the unchanged pinned Weft CLI through Access.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
function requireValue(value, code) { if (!value) throw new Error(code); }

/** Translate only the selected project's Weft requests; the provider verifies the JWT. */
export function createConfidenceAccessFetch({ origin, projectId }, transport = globalThis.fetch) {
  let application;
  try { application = new URL(origin); } catch { throw new Error('WEFT_ACCESS_CONFIGURATION'); }
  requireValue(application.protocol === 'https:' && application.origin === origin
    && typeof projectId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(projectId)
    && typeof transport === 'function', 'WEFT_ACCESS_CONFIGURATION');
  const prefix = `/api/projects/${projectId}/weft/api/workspaces/`;
  return async (input, init) => {
    let url;
    try { url = new URL(input instanceof Request ? input.url : input); } catch { throw new Error('WEFT_ACCESS_DESTINATION'); }
    const segments = url.pathname.slice(prefix.length).split('/');
    requireValue(url.href.length <= 2048 && url.origin === origin && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.startsWith(prefix) && segments.length >= 2 && segments.every(segment => /^[A-Za-z0-9_-]+$/.test(segment)),
    'WEFT_ACCESS_DESTINATION');
    const request = new Request(input, init), headers = new Headers(request.headers);
    const authorization = headers.get('Authorization');
    requireValue(typeof authorization === 'string' && authorization.length <= 16_391
      && /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)
      && !headers.has('CF-Access-Token') && !headers.has('CF-Access-Jwt-Assertion') && !headers.has('Cookie'),
    'WEFT_ACCESS_CREDENTIAL_REQUIRED');
    requireValue(headers.get('Origin') === origin && headers.get('X-Platform-CSRF') === '1', 'WEFT_ACCESS_APPLICATION_HEADERS_REQUIRED');
    headers.delete('Authorization');
    headers.set('CF-Access-Token', authorization.slice('Bearer '.length));
    // Access ingress supplies the signed assertion. Never mint or inject one here.
    return transport(new Request(request, { headers, redirect: 'error' }));
  };
}

const origin = process.env.CONFIDENCE_ORIGIN, projectId = process.env.CONFIDENCE_PROJECT_ID;
const preloaded = process.execArgv.some((argument, index) => {
  const value = argument === '--import' ? process.execArgv[index + 1] : argument.startsWith('--import=') ? argument.slice('--import='.length) : undefined;
  return value && (value.startsWith('file:') ? value : pathToFileURL(resolve(value)).href) === import.meta.url;
});
if (preloaded || origin !== undefined || projectId !== undefined) {
  requireValue(origin && projectId, 'WEFT_ACCESS_CONFIGURATION');
  globalThis.fetch = createConfidenceAccessFetch({ origin, projectId });
}
