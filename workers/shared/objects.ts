// SPDX-License-Identifier: Apache-2.0
import { digestBytes, PlatformError, requireValue } from "./errors";
import { withinDeadline } from "./deadline";

// Bounded control envelopes/observations; full source closures and portable
// bundles use their separately declared limits. This accommodates the pilot's
// 2,048-entry manifest without weakening its 4 MiB source ceiling.
export const MAX_CONTROL_BYTES = 1 * 1024 * 1024;
// Pilot kernel profile is deliberately smaller than the proposed design ceilings.
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
// Consumer capacity for the explicitly selected Confidence repository profile.
// This does not register execution or grant enrollment/publication authority.
export const MAX_CONFIDENCE_REPOSITORY_SOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_FILE_BYTES = 1 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const OBJECT_TIMEOUT_MS = 5000;
const DEADLINE_CODE = "OBJECT_STORE_DEADLINE_EXCEEDED";

/** One deadline covers binding calls, bodies and readback for one operation. */
class ObjectOperation {
  private closed = false;
  private cancelBody?: () => void;
  constructor(private readonly expires: number) {}
  check(): void {
    if (this.closed || Date.now() >= this.expires) throw new PlatformError(DEADLINE_CODE, 503);
  }
  close(): void { this.closed = true; this.cancelBody?.(); }
  async call<T>(operation: () => Promise<T>): Promise<T> {
    this.check(); const result = await operation(); this.check(); return result;
  }
  async read(bucket: R2Bucket, key: string, maximum: number): Promise<Uint8Array | null> {
    this.check();
    // R2 RPC has no AbortSignal. If get resolves after our deadline, acquire
    // and cancel its body rather than starting another stage of the operation.
    const result = await bucket.get(key);
    if (!result) { this.check(); return null; }
    const reader = result.body.getReader();
    let cancelled = false, complete = false, size = 0;
    const cancel = () => {
      if (!cancelled) { cancelled = true; void reader.cancel(DEADLINE_CODE).catch(() => {}); }
    };
    this.cancelBody = cancel;
    const chunks: Uint8Array[] = [];
    try {
      this.check(); requireValue(result.size <= maximum, "SIZE_LIMIT", 413);
      for (;;) {
        const { done, value } = await reader.read(); this.check();
        if (done) break;
        size += value.byteLength; requireValue(size <= maximum, "SIZE_LIMIT", 413); chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      complete = true; return bytes;
    } finally {
      // Cancellation is best effort and must not extend the caller's deadline.
      // Its rejection is observed even when the underlying stream stays open.
      if (!complete) cancel();
      this.cancelBody = undefined; reader.releaseLock();
    }
  }
}

export class ObjectStore {
  constructor(private readonly bucket: R2Bucket, private readonly timeoutMs = OBJECT_TIMEOUT_MS) {}
  private async bounded<T>(operation: (context: ObjectOperation) => Promise<T>): Promise<T> {
    const context = new ObjectOperation(Date.now() + this.timeoutMs);
    try { return await withinDeadline(() => operation(context), this.timeoutMs, DEADLINE_CODE); }
    finally { context.close(); }
  }
  key(digest: string): string {
    requireValue(/^sha256:[0-9a-f]{64}$/.test(digest), "INVALID_DIGEST");
    return `objects/sha256/${digest.slice(7)}`;
  }
  async put(bytes: Uint8Array, expected?: string): Promise<string> {
    // Preserve the exact bytes if a binding write completes after we time out.
    const retained = bytes.slice();
    return this.bounded(async context => {
      const digest = await context.call(() => digestBytes(retained));
      if (expected) requireValue(digest === expected, "OBJECT_DIGEST_MISMATCH");
      const key = this.key(digest);
      const prior = await context.call(() => this.bucket.head(key));
      if (!prior) await context.call(() => this.bucket.put(key, retained, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { digest } }));
      // A deadline does not prove the conditional write failed. A later caller
      // can only use the same content key and must still verify its readback.
      const persisted = await this.readDigest(context, digest, retained.length);
      requireValue(persisted.length === retained.length, "OBJECT_READBACK_MISMATCH", 503);
      return digest;
    });
  }
  async get(digest: string, maximum = MAX_CONTROL_BYTES): Promise<Uint8Array> {
    return this.bounded(context => this.readDigest(context, digest, maximum));
  }
  private async readDigest(context: ObjectOperation, digest: string, maximum: number): Promise<Uint8Array> {
    const bytes = await context.read(this.bucket, this.key(digest), maximum);
    if (!bytes) throw new PlatformError("REQUIRED_OBJECT_MISSING", 409);
    requireValue(await context.call(() => digestBytes(bytes)) === digest, "OBJECT_DIGEST_MISMATCH", 409);
    return bytes;
  }
  /** Journal reads share the binding/body/digest deadline, including recovery. */
  async getJournal(key: string, expected?: string): Promise<Uint8Array | null> {
    requireValue(/^journal\/[a-zA-Z0-9/_-]+$/.test(key), "INVALID_JOURNAL");
    if (expected) requireValue(/^sha256:[0-9a-f]{64}$/.test(expected), "INVALID_DIGEST");
    return this.bounded(async context => {
      const bytes = await context.read(this.bucket, key, MAX_CONTROL_BYTES);
      if (bytes && expected) requireValue(await context.call(() => digestBytes(bytes)) === expected, "JOURNAL_DIGEST_MISMATCH", 409);
      return bytes;
    });
  }
  async putJournal(key: string, bytes: Uint8Array): Promise<string> {
    requireValue(bytes.length <= MAX_CONTROL_BYTES && /^journal\/[a-zA-Z0-9/_-]+$/.test(key), "INVALID_JOURNAL");
    const retained = bytes.slice();
    return this.bounded(async context => {
      const digest = await context.call(() => digestBytes(retained));
      const prior = await context.read(this.bucket, key, MAX_CONTROL_BYTES);
      if (prior) {
        requireValue(await context.call(() => digestBytes(prior)) === digest, "JOURNAL_SINGLE_ASSIGNMENT", 409);
      } else {
        await context.call(() => this.bucket.put(key, retained, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { digest } }));
      }
      const readback = await context.read(this.bucket, key, MAX_CONTROL_BYTES);
      requireValue(readback && await context.call(() => digestBytes(readback)) === digest, "JOURNAL_READBACK_FAILED", 503);
      return digest;
    });
  }
}
