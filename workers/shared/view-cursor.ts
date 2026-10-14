// SPDX-License-Identifier: Apache-2.0
/** A cache hint for a captured display projection, never an authority revision. */
export interface ViewCursor {
  projectIncarnation: string;
  revision: string;
  eventSequence: number;
  capsuleRowid: number;
  selectedCandidateId?: string;
}

export function sameViewCursor(left: ViewCursor, right: ViewCursor): boolean {
  return left.projectIncarnation === right.projectIncarnation && left.revision === right.revision
    && left.eventSequence === right.eventSequence && left.capsuleRowid === right.capsuleRowid
    && left.selectedCandidateId === right.selectedCandidateId;
}
