import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { canonicalize, getKernel } from '../../packages/protocol/src/index.ts';
import type { SourceManifest } from '../../packages/protocol/src/types.ts';
before(initializeKernel);
const scope = { schemaVersion: 1, tenantId: 't', projectId: 'p', projectIncarnation: 'i' };
const h = 'sha256:' + '1'.repeat(64);
const grant = { scope, id: 'grant', subjectId: 'agent', attemptId: 'attempt', generation: '1', authorityGeneration: '1', operations: ['model-inference','write-attempt'], resources: ['repo'], pathPrefixes: ['src'], destinations: ['api.openai.com'], startsAt: 1000, expiresAt: 2000, budgetMicroUnits: '1000', revoked: false };
function run(method: 'validate_grant'|'grant_inclusion'|'budget_transition'|'compose_manifests'|'transplant_manifest', value: unknown) { return JSON.parse(getKernel()[method](canonicalize(value))); }
test('grant paths use component containment and generation fencing', () => {
  const request = { grant, currentScope: scope, subjectId: 'agent', attemptId: 'attempt', currentGeneration: '1', currentAuthorityGeneration: '1', operation: 'write-attempt', resource: 'repo', path: 'src/cache.ts', destination: null, now: 1200, maximumCost: '100', availableBudget: '500' };
  assert.equal(run('validate_grant', request).accepted, true);
  assert.equal(run('validate_grant', { ...request, path: 'src-admin/secrets' }).reason, 'GRANT_PATH_DENIED');
  assert.equal(run('validate_grant', { ...request, currentGeneration: '2' }).reason, 'GRANT_GENERATION_FENCED');
  assert.equal(run('validate_grant', { ...request, operation: 'publish' }).reason, 'GRANT_OPERATION_DENIED');
  assert.equal(run('validate_grant', { ...request, destination: 'api.openai.com.evil.invalid' }).reason, 'GRANT_DESTINATION_DENIED');
  assert.equal(run('validate_grant', { ...request, grant: { ...grant, revoked: true } }).reason, 'GRANT_REVOKED');
});
test('delegation cannot expand resources, expiry or reserved budget', () => {
  const child = { ...grant, id: 'child', pathPrefixes: ['src/components'], expiresAt: 1900, budgetMicroUnits: '500' };
  assert.equal(run('grant_inclusion', { parent: grant, child }).accepted, true);
  for (const change of [{ resources: ['other'] }, { expiresAt: 2100 }, { pathPrefixes: ['src-privileged'] }, { budgetMicroUnits: '1001' }]) {
    assert.equal(run('grant_inclusion', { parent: grant, child: { ...child, ...change } }).reason, 'DELEGATION_EXPANDS_SCOPE');
  }
});
test('unknown dispatched spend cannot be released and conservatively settles', () => {
  const state = { limit: '1000', held: '600', settled: '100', reservation: '600', phase: 'UNKNOWN', observedCost: null };
  assert.equal(run('budget_transition', { ...state, event: 'RELEASE' }).reason, 'INVALID_BUDGET_TRANSITION');
  assert.deepEqual(run('budget_transition', { ...state, event: 'SETTLE' }), { accepted: true, held: '0', phase: 'SETTLED', settled: '700' });
  assert.equal(run('budget_transition', { ...state, reservation: '301', phase: 'NONE', event: 'RESERVE' }).reason, 'BUDGET_EXHAUSTED');
});
test('logical completion and cancellation retain occupied capacity until whole-generation stop', () => {
  const state = {generation:'1',eventGeneration:'1',lifecycle:'RUNNING',outcome:'PENDING',admissions:'OPEN',verified:true};
  const next = (value: unknown) => JSON.parse(getKernel().transition_execution(canonicalize(value)));
  const completed = next({...state,event:'COMPLETION_OBSERVED'});
  assert.equal(completed.capacityHeld,true);assert.equal(completed.mayReplaceGeneration,false);assert.equal(completed.outcome,'COMPLETED');
  const cancelled = next({...state,event:'CANCEL'});assert.equal(cancelled.capacityHeld,true);assert.equal(cancelled.admissions,'FENCED');
  const stopped = next({...state,lifecycle:'STOP_REQUESTED',outcome:'CANCELLED',admissions:'FENCED',event:'STOP_CONFIRMED'});
  assert.equal(stopped.capacityHeld,false);assert.equal(stopped.mayReplaceGeneration,true);
  assert.equal(next({...state,eventGeneration:'0',event:'COMPLETION_OBSERVED'}).reason,'EXECUTION_GENERATION_FENCED');
  assert.equal(next({...state,lifecycle:'UNKNOWN',event:'DISPATCH_START'}).reason,'INVALID_EXECUTION_TRANSITION');
});
function manifest(entries: { path: string; digest?: string; mode?: '100644'|'100755' }[]): SourceManifest {
  return { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: entries.map(x => ({ path: x.path, digest: x.digest ?? h, mode: x.mode ?? '100644', bytes: '1' })).sort((a,b) => a.path < b.path ? -1 : 1) };
}
test('composition combines disjoint whole-file deltas but refuses overlap', () => {
  const base = manifest([{ path: 'a' },{ path: 'b' }]); const changed = 'sha256:' + '2'.repeat(64);
  const a = manifest([{ path: 'a', digest: changed }, { path: 'b' }]); const b = manifest([{ path: 'a' }, { path: 'b', mode: '100755' }]);
  const combined = run('compose_manifests', { base, submissions: [{id:'A',manifest:a},{id:'B',manifest:b}] });
  assert.equal(combined.accepted, true); assert.equal(combined.manifest.entries[0].digest, changed); assert.equal(combined.manifest.entries[1].mode, '100755');
  const overlap = manifest([{path:'a',digest:'sha256:'+'3'.repeat(64)},{path:'b'}]);
  assert.equal(run('compose_manifests', {base,submissions:[{id:'A',manifest:a},{id:'B',manifest:overlap}]}).reason, 'MECHANICAL_CONFLICT');
  assert.equal(run('compose_manifests', {base,submissions:[{id:'A',manifest:a},{id:'B',manifest:a}]}).accepted, true);
});
test('transplant guards each changed entry and validates the complete resulting tree', () => {
  const originalBase=manifest([{path:'a'}]); const desired=manifest([{path:'a',mode:'100755'}]);
  assert.equal(run('transplant_manifest',{originalBase,desired,currentBase:manifest([{path:'a'},{path:'new'}])}).accepted,true);
  assert.equal(run('transplant_manifest',{originalBase,desired,currentBase:manifest([{path:'a',digest:'sha256:'+'2'.repeat(64)}])}).reason,'TRANSPLANT_CONFLICT');
  const collision=run('transplant_manifest',{originalBase:manifest([]),desired:manifest([{path:'a'}]),currentBase:manifest([{path:'a/child'}])});
  assert.equal(collision.accepted,false); assert.equal(collision.reason,'FILE_DIRECTORY_COLLISION');
});
