import { invalidate } from './cache.mjs';
export async function writeValue(value, writeStore) {
  await writeStore(value);
  invalidate();
  return value;
}
