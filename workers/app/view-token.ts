// SPDX-License-Identifier: Apache-2.0
import type { ViewCursor } from '../shared/view-cursor';

export interface ViewScope {
  principalId: string;
  tenantId: string;
  projectId: string;
  credentialClass: 'human' | 'agent' | 'service';
  pi: boolean;
  publication: boolean;
  maintenance: boolean;
  selectedCandidateId?: string;
}

/** This token only controls reuse of a display snapshot. It never authorizes a command. */
export function issueViewToken(scope: ViewScope, cursor: ViewCursor): string {
  return encodeURIComponent(JSON.stringify({ version: 1, ...scope, cursor }));
}

export function priorViewCursor(token: string | null, scope: ViewScope): ViewCursor | null {
  if (!token || token.length > 2048) return null;
  try {
    const value = JSON.parse(decodeURIComponent(token)) as Record<string, unknown>;
    if (value.version !== 1 || value.principalId !== scope.principalId || value.tenantId !== scope.tenantId
      || value.projectId !== scope.projectId || value.credentialClass !== scope.credentialClass
      || value.pi !== scope.pi || value.publication !== scope.publication || value.maintenance !== scope.maintenance
      || value.selectedCandidateId !== scope.selectedCandidateId) return null;
    const cursor = value.cursor as Partial<ViewCursor> | null;
    if (!cursor || typeof cursor.projectIncarnation !== 'string' || !cursor.projectIncarnation
      || typeof cursor.revision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(cursor.revision)
      || !Number.isSafeInteger(cursor.eventSequence) || cursor.eventSequence! < 0
      || !Number.isSafeInteger(cursor.capsuleRowid) || cursor.capsuleRowid! < 0
      || cursor.selectedCandidateId !== scope.selectedCandidateId) return null;
    return cursor as ViewCursor;
  } catch { return null; }
}
