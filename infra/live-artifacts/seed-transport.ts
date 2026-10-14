// SPDX-License-Identifier: Apache-2.0
import { requireValue } from '../../workers/shared/errors';

export function seedRequest(remote: URL, plaintext: string, bytes: Uint8Array): Request {
  // workerd supports manual/follow; redirect:error throws before dispatch.
  return new Request(`${remote.href}/git-receive-pack`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' }, body: bytes.slice().buffer });
}
export function requireSeedResponse(response: Response): void {
  requireValue(response.status < 300 || response.status >= 400, 'GIT_REDIRECT_DENIED', 502);
}
