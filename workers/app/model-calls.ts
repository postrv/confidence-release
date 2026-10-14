// SPDX-License-Identifier: Apache-2.0
import { requireValue } from '../shared/errors';

/** Read-only accounting pages are pinned to the project incarnation, not a mutable view. */
export function modelCallPageQuery(url: URL, headerIncarnation: string | null): { after: string; limit: number; expectedIncarnation: string } {
  const keys = [...url.searchParams.keys()];
  requireValue(keys.every(key => ['after', 'limit', 'incarnation'].includes(key))
    && keys.every(key => url.searchParams.getAll(key).length === 1), 'MODEL_CALL_QUERY_INVALID');
  const after = url.searchParams.get('after') ?? '0';
  const limit = url.searchParams.get('limit') ?? '100';
  const expectedIncarnation = url.searchParams.get('incarnation');
  requireValue(/^(0|[1-9][0-9]{0,18})$/.test(after) && BigInt(after) <= 9223372036854775807n, 'MODEL_CALL_CURSOR_INVALID');
  requireValue(/^(?:[1-9]|[1-9][0-9]|100)$/.test(limit), 'MODEL_CALL_LIMIT_INVALID');
  requireValue(expectedIncarnation !== null && /^[a-zA-Z0-9_-]{1,128}$/.test(expectedIncarnation), 'EXPECTED_INCARNATION_REQUIRED');
  requireValue(headerIncarnation === null || headerIncarnation === expectedIncarnation, 'PROJECT_INCARNATION_CHANGED', 409);
  return { after, limit: Number(limit), expectedIncarnation };
}
