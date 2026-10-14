export async function boundedResponse(response: Response, maximum: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length') || 0) > maximum) { await response.body?.cancel(); throw new Error('Response exceeds registered byte ceiling'); }
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > maximum) { await reader.cancel(); throw new Error('Response exceeds registered byte ceiling'); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let position = 0; for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; } return bytes;
}
