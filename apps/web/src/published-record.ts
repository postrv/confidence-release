import type { Candidate, PlatformState, Publication, Receipt } from '../../../services/types';

export interface PublishedRecord { receipt: Receipt; publication: Publication }

/** Presentation linkage only. Cryptographic verification still requires the exported bundle and selected trust. */
export function publishedRecord(state: PlatformState, candidate?: Candidate): PublishedRecord | undefined {
  if (!candidate || [candidate.id, candidate.digest, candidate.manifestDigest, candidate.commit, candidate.publicationBase,
    state.tenantId, state.projectId, state.projectIncarnation, state.enrollmentDigest].some(value => typeof value !== 'string' || !value)) return undefined;
  const matches: PublishedRecord[] = [];
  for (const receipt of state.receipts.filter(item => item.candidateId === candidate.id)) {
    const logical = receipt.logical;
    if (!logical || logical.schemaVersion !== 1 || logical.outcome !== 'PUBLISHED') continue;
    const scope = logical.scope as Record<string, unknown> | undefined;
    if (!scope || scope.schemaVersion !== 1 || scope.tenantId !== state.tenantId || scope.projectId !== state.projectId
      || scope.projectIncarnation !== state.projectIncarnation || logical.enrollmentDigest !== state.enrollmentDigest
      || logical.candidateDigest !== candidate.digest || logical.manifestDigest !== candidate.manifestDigest
      || logical.newHead !== candidate.commit || logical.oldHead !== candidate.publicationBase
      || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1 || logical.sequence !== String(receipt.sequence)
      || !receipt.digest || !receipt.publicationId || logical.operationId !== receipt.publicationId
      || typeof logical.proposalDigest !== 'string' || !logical.proposalDigest) continue;
    const publications = state.publications.filter(item => item.id === receipt.publicationId && item.candidateId === candidate.id
      && typeof item.status === 'string' && ['PUBLISHED', 'FINALIZED'].includes(item.status.toUpperCase()) && item.newHead === candidate.commit
      && item.oldHead === candidate.publicationBase && item.proposalDigest === logical.proposalDigest);
    if (publications.length === 1) matches.push({ receipt, publication: publications[0]! });
  }
  return matches.length === 1 ? matches[0] : undefined;
}
