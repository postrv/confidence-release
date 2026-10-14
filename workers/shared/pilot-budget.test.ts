import test from 'node:test';
import assert from 'node:assert/strict';
import { PILOT_BUDGET_POLICY_CAP_UNITS, pilotBudgetPolicyCapUnits } from './pilot-budget';

test('only the exact existing R2 incarnation receives the 3.6 million policy ceiling', () => {
  const exact = { tenantId: 'pilot', projectId: 'competition-demo-r2', projectIncarnation: 'c23de474-7628-47be-9cbd-65595953b3ee' };
  assert.equal(PILOT_BUDGET_POLICY_CAP_UNITS, '2800000');
  assert.equal(pilotBudgetPolicyCapUnits(exact), '3600000');
  for (const key of ['tenantId', 'projectId', 'projectIncarnation'] as const) {
    for (const value of ['', exact[key].toUpperCase(), `${exact[key]}-other`]) {
      assert.equal(pilotBudgetPolicyCapUnits({ ...exact, [key]: value }), '2800000', `${key} is an exact scoped boundary`);
    }
  }
});
