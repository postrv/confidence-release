/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlatformState } from '../../../services/types';
import { modelCallSummary } from './model-call-roster';
import { ReleaseStory } from './ReleaseStory';

const state = { tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation', revision: 34 };
const call = { callId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attemptId: 'attempt', generation: '1',
  requestDigest: `sha256:${'a'.repeat(64)}`, maximumCost: '100000', state: 'DISPATCHED' };
const raw = { project: { scope: { tenantId: state.tenantId, projectId: state.projectId, projectIncarnation: state.projectIncarnation }, revision: '34' },
  modelCalls: { limit: 2048, overflow: false, reservations: [call, { ...call, callId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', state: 'SETTLED' }] } };

test('explicit authority roster counts reservations without turning them into usage or cost', () => {
  assert.deepEqual(modelCallSummary(raw, state), { count: 2 });
  assert.deepEqual(modelCallSummary({ ...raw, modelCalls: { ...raw.modelCalls, reservations: [] } }, state), { count: 0 });
});

test('roster read fails closed on project, revision, overflow and malformed reservations', () => {
  assert.throws(() => modelCallSummary({ ...raw, project: { ...raw.project, revision: '33' } }, state), /different project revision/);
  assert.throws(() => modelCallSummary({ ...raw, project: { ...raw.project, scope: { ...raw.project.scope, projectIncarnation: 'other' } } }, state), /different project revision/);
  assert.throws(() => modelCallSummary({ ...raw, modelCalls: { ...raw.modelCalls, overflow: true } }, state), /incomplete or exceeded/);
  assert.throws(() => modelCallSummary({ ...raw, modelCalls: { ...raw.modelCalls, reservations: [call, call] } }, state), /invalid reservation/);
  assert.throws(() => modelCallSummary({ ...raw, modelCalls: { ...raw.modelCalls, reservations: [{ ...call, state: 'UNKNOWN' }] } }, state), /unknown reservation state/);
  assert.throws(() => modelCallSummary({ project: raw.project }, state), /unavailable/);
});

test('scoreboard preserves unmeasured provider cost and offers an explicit roster read', () => {
  const pilot = { ...state, schemaVersion: 1, observationRevision: 1, acceptedHead: 'head', enrollmentDigest: 'enrollment',
    goal: { id: 'goal', revision: '1', title: 'Goal', description: '', constraints: [], contracts: [], budget: { authoringSeconds: 600, evaluationSeconds: 300 } },
    attempts: [{ id: 'attempt', name: 'Model attempt', role: 'A', mode: 'pi', status: 'RUNNING', assigned: '', workBase: 'head', publicationBase: 'head', generation: 1, grantId: 'grant', allowedPaths: ['cache.mjs'] }],
    candidates: [], evaluations: [], evidence: [], conflicts: [], capsules: [], reviews: [], publications: [], receipts: [], commands: [], events: [],
    demoStatus: 'RUNNING', capabilities: { scripted: false, pi: true, publication: false, deployment: true }, limitations: [], gates: [] } as PlatformState;
  const html = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot }));
  assert.match(html, /<dt>Model cost<\/dt><dd class="score-unmeasured">Unmeasured/);
  assert.match(html, /Cloudflare billing and complete usage unverified/);
  assert.match(html, /Read model-call reservations/);
  assert.doesNotMatch(html, /estimated cost|\$0/);
});
