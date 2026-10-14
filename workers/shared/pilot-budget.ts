// SPDX-License-Identifier: Apache-2.0
import type { Scope } from "../../packages/protocol/src/types";

/** Internal admission reservation for one pilot authoring attempt; not provider spend. */
export const PILOT_ATTEMPT_RESERVATION_UNITS = "400000";
/** Default closed-pilot policy limit, including every new enrollment. */
export const PILOT_BUDGET_POLICY_CAP_UNITS = "2800000";

/** This existing owner-only project may receive one further audited 400,000-unit step, up to 3,600,000. */
export function pilotBudgetPolicyCapUnits(scope: Pick<Scope, "tenantId" | "projectId" | "projectIncarnation">): string {
  return scope.tenantId === "pilot"
    && scope.projectId === "competition-demo-r2"
    && scope.projectIncarnation === "c23de474-7628-47be-9cbd-65595953b3ee"
    ? "3600000" : PILOT_BUDGET_POLICY_CAP_UNITS;
}
