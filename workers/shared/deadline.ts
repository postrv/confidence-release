// SPDX-License-Identifier: Apache-2.0
import { PlatformError } from './errors';

/** A timeout observes uncertainty; it does not cancel an RPC or permit replay. */
export async function withinDeadline<T>(operation: () => Promise<T>, timeoutMs: number, code = 'SERVICE_DEADLINE_EXCEEDED'): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new PlatformError(code, 503);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PlatformError(code, 503)), timeoutMs);
  });
  // Promise.race observes late rejection as well as synchronous throws. The
  // underlying RPC can still finish, so its durable identity must stay fixed.
  try { return await Promise.race([Promise.resolve().then(operation), timeout]); }
  finally { clearTimeout(timer); }
}

/** Status-only service call, with one deadline for headers and body disposal. */
export async function boundedServiceFetch(fetcher: { fetch: typeof fetch }, input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const expires = Date.now() + timeoutMs;
  const abort = new AbortController();
  const cancelled = () => abort.abort(init.signal?.reason);
  if (init.signal?.aborted) cancelled();
  else init.signal?.addEventListener('abort', cancelled, { once: true });
  try {
    const response = await withinDeadline(() => fetcher.fetch(input, { ...init, signal: abort.signal }), expires - Date.now());
    await withinDeadline(async () => { await response.body?.cancel(); }, expires - Date.now());
    return response;
  } finally {
    init.signal?.removeEventListener('abort', cancelled);
    abort.abort();
  }
}
