// SPDX-License-Identifier: Apache-2.0
import { PINNED_WEFT_DEPENDENCY } from '../../packages/protocol/src/dependencies';
import { digestBytes, readBounded, requireValue } from '../shared/errors';
import { withinDeadline } from '../shared/deadline';

export const WEFT_DEPENDENCY_KEY = `dependencies/weft/${PINNED_WEFT_DEPENDENCY.bundle.sha256}.bundle`;
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };

/** Called only after project authorization; repeat authorization after every external await. */
export async function pinnedWeftDependency(bucket: R2Bucket, bundle: boolean, authorize: () => void): Promise<Response> {
  authorize();
  if (!bundle) return Response.json(PINNED_WEFT_DEPENDENCY, { headers });
  const controller = new AbortController(), expires = Date.now() + 15_000;
  let object: R2ObjectBody | null | undefined, closed = false;
  const checkDeadline = () => requireValue(!closed && Date.now() < expires, 'DEPENDENCY_READ_TIMEOUT', 503);
  const dispose = () => {
    if (object?.body && !object.body.locked) void object.body.cancel().catch(() => { /* Disposal cannot extend the caller deadline. */ });
  };
  try {
    return await withinDeadline(async () => {
      object = await bucket.get(WEFT_DEPENDENCY_KEY);
      // R2 get cannot be aborted. Dispose a late body without beginning another
      // stage after the caller has already observed the operation's deadline.
      if (closed || Date.now() >= expires) { dispose(); checkDeadline(); }
      authorize();
      requireValue(object && object.size === PINNED_WEFT_DEPENDENCY.bundle.bytes, 'DEPENDENCY_UNAVAILABLE', 503);
      const stream = object.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: controller.signal });
      const bytes = await readBounded(stream, PINNED_WEFT_DEPENDENCY.bundle.bytes); checkDeadline(); authorize();
      requireValue(bytes.length === PINNED_WEFT_DEPENDENCY.bundle.bytes, 'DEPENDENCY_INTEGRITY_FAILED', 503);
      const actualDigest = await digestBytes(bytes); checkDeadline(); authorize();
      requireValue(actualDigest === `sha256:${PINNED_WEFT_DEPENDENCY.bundle.sha256}`, 'DEPENDENCY_INTEGRITY_FAILED', 503);
      return new Response(bytes.slice().buffer, { headers: { ...headers, 'content-type': 'application/x-git-bundle',
        'content-disposition': `attachment; filename="weft-${PINNED_WEFT_DEPENDENCY.commit}.bundle"`,
        'content-length': String(bytes.length), 'x-confidence-sha256': PINNED_WEFT_DEPENDENCY.bundle.sha256 } });
    }, 15_000, 'DEPENDENCY_READ_TIMEOUT');
  } finally { closed = true; controller.abort(); dispose(); }
}
