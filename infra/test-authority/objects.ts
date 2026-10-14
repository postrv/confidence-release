// TEST ONLY: timing wrappers around the actual local workerd R2 binding.
import assert from 'node:assert/strict';
import { ObjectStore } from '../../workers/shared/objects';
import { digestBytes } from '../../workers/shared/errors';

export async function objectStoreDeadlineChecks(bucket: R2Bucket): Promise<string[]> {
  const bytes = new TextEncoder().encode(`owned-r2-deadline-${crypto.randomUUID()}`);
  const digest = await digestBytes(bytes), normal = new ObjectStore(bucket);
  assert.equal(await normal.put(bytes), digest);
  assert.deepEqual(await normal.get(digest), bytes);
  const expected = { code: 'OBJECT_STORE_DEADLINE_EXCEEDED', status: 503 };
  const checks: string[] = [];

  let releaseHeaders!: () => void, lateBodyCancelled!: () => void;
  const headerGate = new Promise<void>(resolve => { releaseHeaders = resolve; });
  const lateCancellation = new Promise<void>(resolve => { lateBodyCancelled = resolve; });
  const late = new ObjectStore({ get: async (key: string) => {
    const result = await bucket.get(key); assert.ok(result);
    await headerGate;
    return { size: result.size, body: new ReadableStream<Uint8Array>({
      cancel() { lateBodyCancelled(); return result.body.cancel(); },
    }) };
  } } as unknown as R2Bucket, 50);
  await assert.rejects(late.get(digest), expected);
  releaseHeaders(); await lateCancellation;
  checks.push('Actual workerd cancels an R2 body returned after the shared object deadline');

  let cancelled = false;
  const stalled = new ObjectStore({ get: async (key: string) => {
    const result = await bucket.get(key); assert.ok(result);
    return { size: result.size, body: new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; return result.body.cancel(); },
    }) };
  } } as unknown as R2Bucket, 50);
  await assert.rejects(stalled.get(digest), expected); assert.equal(cancelled, true);
  checks.push('Actual workerd bounds stalled R2 body consumption and cancels the held body');

  let releaseWrite!: () => void, writeSettled!: () => void, reads = 0, writes = 0;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const settled = new Promise<void>(resolve => { writeSettled = resolve; });
  const key = `journal/owned_deadline/${crypto.randomUUID()}`, input = bytes.slice();
  const uncertain = new ObjectStore({
    get: async (requested: string) => { reads++; return bucket.get(requested); },
    put: async (requested: string, value: Uint8Array, options: R2PutOptions) => {
      writes++; await writeGate;
      const result = await bucket.put(requested, value, options); writeSettled(); return result;
    },
  } as unknown as R2Bucket, 50);
  await assert.rejects(uncertain.putJournal(key, input), expected);
  input.fill(0); releaseWrite(); await settled;
  assert.equal(reads, 1); assert.equal(writes, 1);
  assert.equal(await normal.putJournal(key, bytes), digest);
  await assert.rejects(normal.putJournal(key, new TextEncoder().encode('changed intent')), { code: 'JOURNAL_SINGLE_ASSIGNMENT', status: 409 });
  const retained = await bucket.get(key); assert.ok(retained); assert.deepEqual(new Uint8Array(await retained.arrayBuffer()), bytes);
  checks.push('A late real R2 conditional journal write preserves exact bytes; explicit retry reconciles and a changed intent cannot overwrite it');
  return checks;
}
