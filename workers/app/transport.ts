import { withinDeadline } from '../shared/deadline';
import { PlatformError } from '../shared/errors';

/** Bound the full internal response, including a body that stops making progress. */
export async function authorityResponse(fetcher: { fetch: typeof fetch }, input: RequestInfo | URL, init: RequestInit, timeoutMs = 10_000, maximumBytes = 8 * 1024 * 1024): Promise<Response> {
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    return await withinDeadline(async () => {
      const response = await fetcher.fetch(input, { ...init, signal: abort.signal });
      reader = response.body?.getReader();
      if (abort.signal.aborted) { void reader?.cancel().catch(() => {}); throw new PlatformError('SERVICE_DEADLINE_EXCEEDED', 503); }
      const chunks: Uint8Array[] = []; let size = 0;
      while (reader) {
        const next = await reader.read();
        if (abort.signal.aborted) throw new PlatformError('SERVICE_DEADLINE_EXCEEDED', 503);
        if (next.done) break;
        size += next.value.length; if (size > maximumBytes) throw new PlatformError('SIZE_LIMIT', 413);
        chunks.push(next.value);
      }
      const body = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
      const headers = new Headers(response.headers); headers.set('cache-control', 'no-store'); headers.set('x-content-type-options', 'nosniff');
      return new Response(body.slice().buffer, { status: response.status, headers });
    }, timeoutMs);
  } finally { abort.abort(); void reader?.cancel().catch(() => {}); }
}
