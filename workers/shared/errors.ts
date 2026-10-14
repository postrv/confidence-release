// SPDX-License-Identifier: Apache-2.0
export class PlatformError extends Error {
  constructor(public readonly code: string, public readonly status = 400, message = code) { super(message); }
}

export function errorResponse(error: unknown): Response {
  const safe = error instanceof PlatformError ? error : new PlatformError("INFRASTRUCTURE_UNAVAILABLE", 503);
  return Response.json({ error: { code: safe.code, message: safe.message } }, { status: safe.status, headers: { "cache-control": "no-store" } });
}

export function requireValue(condition: unknown, code: string, status = 400): asserts condition {
  if (!condition) throw new PlatformError(code, status);
}

export async function readBounded(stream: ReadableStream<Uint8Array> | null, maximum: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel("SIZE_LIMIT"); throw new PlatformError("SIZE_LIMIT", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function digestBytes(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
  return `sha256:${Array.from(hash, n => n.toString(16).padStart(2, "0")).join("")}`;
}
