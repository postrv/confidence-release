// Baseline: cache is intentionally disabled. A's declared task enables this TTL.
export const cacheTtlMs = 0;
let cached;
let cacheGeneration = {};
export async function readValue(readStore) {
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const generation = cacheGeneration;
  const value = await readStore();
  if (cacheTtlMs > 0 && generation === cacheGeneration) cached = { value, expiresAt: Date.now() + cacheTtlMs };
  return value;
}
export function invalidate() { cacheGeneration = {}; cached = undefined; }
