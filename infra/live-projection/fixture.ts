// SPDX-License-Identifier: Apache-2.0
// Owned synthetic retained history. This is not ProjectAuthority or a receipt.
import { digest } from '../../packages/protocol/src/index';
import type { Scope } from '../../packages/protocol/src/types';
export interface FixtureEvent {id:string;scope:Scope;sequence:number;kind:string;objectId:string;payload:unknown;digest:string}
export function ownedScope(runId: string) { return {schemaVersion:1 as const,tenantId:'owned-live-projection',projectId:'probe-'+runId.replaceAll('-',''),projectIncarnation:runId}; }
export async function originalEvents(runId: string): Promise<FixtureEvent[]> {
  return Promise.all(Array.from({length:5},async(_,i)=>{
    const identity={id:`live/${runId}/${i+1}`,scope:ownedScope(runId),sequence:i+1,kind:'OWNED_SYNTHETIC_HISTORY',objectId:`fixture/${i+1}:original`,payload:{schemaVersion:1,value:i+1,producer:'fixed-owned-fixture'}};
    return {...identity,digest:await digest(identity)};
  }));
}
export const stages=['first','gap','recover','duplicates','empty','rebuild'] as const;
export type Stage=typeof stages[number];
