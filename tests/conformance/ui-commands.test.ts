import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, request } from '../../apps/web/src/api';
import { CommandSession, freezeCommand, type PendingCommand } from '../../apps/web/src/commands';
import { authorityResponse } from '../../workers/app/transport';
import type { PlatformState } from '../../services/types';

function state(): PlatformState {
  return { tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation', revision: 7,
    session: { principalId: 'issuer#reader', credentialClass: 'human' }, capabilities: { deployment: true },
    attempts: [{ id: 'a', submissionId: 'submission-a' }, { id: 'b', submissionId: 'submission-b' }],
    candidates: [{ id: 'candidate', reviewEvaluationId: 'evaluation-original' }], reviews: [{ id: 'review', proposalDigest: 'original-proposal' }],
    conflicts: [{ id: 'conflict', candidateId: 'candidate' }], publications: [{ id: 'publication', status: 'UNKNOWN' }],
  } as PlatformState;
}
function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

test('deployed commands resolve exact semantic inputs once, including evaluation and publication identities', () => {
  const initial = state();
  const selection = freezeCommand(initial, 'Compose', '/api/select', { attemptIds: ['b', 'a'] }, 'command-selection');
  assert.equal(selection.path, '/v1/projects/project/materialize');
  assert.deepEqual(JSON.parse(selection.body), { submissionIds: ['submission-a', 'submission-b'], evaluate: true });
  assert.equal(selection.headers['If-Platform-Revision'], '7');
  assert.equal(selection.headers['If-Platform-Principal'], 'issuer#reader');
  assert.equal(selection.headers['If-Platform-Incarnation'], 'incarnation');
  const review = freezeCommand(initial, 'Review', '/api/review', { candidateId: 'candidate' }, 'review-command');
  const reconciliation = freezeCommand(initial, 'Reconcile', '/api/reconcile', {}, 'reconcile-command');
  initial.candidates[0].reviewEvaluationId = 'new-evaluation'; initial.publications[0].id = 'new-publication'; initial.attempts[0].submissionId = 'replacement';
  assert.deepEqual(JSON.parse(review.body), { candidateId: 'candidate', evaluationId: 'evaluation-original' });
  assert.deepEqual(JSON.parse(reconciliation.body), { publicationId: 'publication' });
  assert.deepEqual(JSON.parse(selection.body).submissionIds, ['submission-a', 'submission-b']);
});

test('audited budget increase freezes only the authoritative one-repair shortfall and human reason', () => {
  const initial = state();
  Object.assign(initial, { tenantId: 'pilot', projectId: 'competition-demo-r2', projectIncarnation: 'c23de474-7628-47be-9cbd-65595953b3ee' });
  initial.projectBudget = { maximumUnits: '3200000', reservedUnits: '0', settledUnits: '3200000', availableUnits: '0', repairReservationUnits: '400000', policyCapUnits: '3600000' };
  const reason = 'One bounded repair for the recorded interaction.';
  const command = freezeCommand(initial, 'Increase budget', '/api/increase-budget', { reason, newMaximumBudget: '9999999' }, 'budget-command');
  assert.equal(command.path, '/v1/projects/competition-demo-r2/increase-budget');
  assert.deepEqual(JSON.parse(command.body), { expectedMaximumBudget: '3200000', newMaximumBudget: '3600000', reason });
  assert.equal(command.headers['If-Platform-Revision'], '7');
  initial.projectBudget.maximumUnits = '3600000';
  assert.deepEqual(JSON.parse(command.body), { expectedMaximumBudget: '3200000', newMaximumBudget: '3600000', reason });
  assert.throws(() => freezeCommand(initial, 'Increase budget', '/api/increase-budget', { reason }), /verified human session and current capacity shortfall/i);
  const earlier = state();
  Object.assign(earlier, { tenantId: initial.tenantId, projectId: initial.projectId, projectIncarnation: initial.projectIncarnation });
  earlier.projectBudget = { maximumUnits: '2400000', reservedUnits: '0', settledUnits: '2400000', availableUnits: '0', repairReservationUnits: '400000', policyCapUnits: '3200000' };
  assert.deepEqual(JSON.parse(freezeCommand(earlier, 'Increase budget', '/api/increase-budget', { reason }, 'earlier-budget-command').body),
    { expectedMaximumBudget: '2400000', newMaximumBudget: '2800000', reason });
  const untrusted = state();
  Object.assign(untrusted, { tenantId: initial.tenantId, projectId: initial.projectId, projectIncarnation: initial.projectIncarnation });
  untrusted.projectBudget = { maximumUnits: '2800000', reservedUnits: '0', settledUnits: '2800000', availableUnits: '0', repairReservationUnits: '400000', policyCapUnits: '3200000' };
  untrusted.session = { principalId: 'agent', credentialClass: 'agent' };
  assert.throws(() => freezeCommand(untrusted, 'Increase budget', '/api/increase-budget', { reason }), /verified human session/i);
});

test('maintenance blocks new deployed intents before writing a recovery record or sending', async () => {
  const paused = state(); paused.capabilities.maintenance = true;
  assert.throws(() => freezeCommand(paused, 'Increase budget', '/api/increase-budget', { reason: 'One repair' }), /Maintenance mode is read-only/);
  assert.throws(() => freezeCommand(paused, 'Launch', '/api/demo', { mode: 'pi' }), /Maintenance mode is read-only/);
  const retained = storage(); let sent = 0;
  const session = new CommandSession(retained, async () => { sent++; });
  await assert.rejects(session.begin(paused, 'Launch', '/api/demo', { mode: 'pi' }), /Maintenance mode is read-only/);
  assert.equal(sent, 0);
  assert.equal(session.getSnapshot().pending, undefined);
  const current = state();
  const uncertain = new CommandSession(retained, async () => { sent++; throw new ApiError('response lost'); });
  assert.equal(await uncertain.begin(current, 'Launch', '/api/demo', { mode: 'pi' }), false);
  assert.equal(uncertain.getSnapshot().pending?.status, 'UNKNOWN');
  const frozen = JSON.stringify(uncertain.getSnapshot().pending);
  await assert.rejects(uncertain.retry(paused), /Maintenance mode is read-only/);
  assert.equal(sent, 1);
  assert.equal(JSON.stringify(uncertain.getSnapshot().pending), frozen);
});

test('a lost response and page reload preserve the original command bytes and revision on retry', async () => {
  const retained = storage(), sent: PendingCommand[] = [], initial = state();
  const first = new CommandSession(retained, async command => { sent.push(structuredClone(command)); throw new ApiError('No response'); });
  assert.equal(await first.begin(initial, 'Prepare review', '/api/review', { candidateId: 'candidate' }), false);
  assert.equal(first.getSnapshot().pending?.status, 'UNKNOWN');
  await assert.rejects(first.begin(initial, 'New action', '/api/repair', { conflictId: 'conflict' }), /Resolve the retained command/);
  const recovered = new CommandSession(retained, async command => { sent.push(structuredClone(command)); return {}; });
  initial.revision = 100; initial.candidates[0].reviewEvaluationId = 'later-plan';
  assert.equal(await recovered.retry(initial), true);
  for (const field of ['id', 'scope', 'path', 'body', 'headers'] as const) assert.deepEqual(sent[1][field], sent[0][field]);
  assert.equal(recovered.getSnapshot().pending, undefined);
  assert.equal(new CommandSession(retained).getSnapshot().pending, undefined);
});

test('uncertain commands never replay under another principal or incarnation and access failures remain uncertain', async () => {
  for (const changed of [{ session: { principalId: 'issuer#other', credentialClass: 'human' as const } }, { projectIncarnation: 'replacement' }]) {
    let calls = 0;
    const session = new CommandSession(storage(), async () => { calls++; throw new ApiError('timeout'); });
    await session.begin(state(), 'Launch', '/api/demo', { mode: 'pi' });
    await assert.rejects(session.retry({ ...state(), ...changed }), /different principal or project incarnation/);
    assert.equal(calls, 1);
    assert.equal(session.getSnapshot().pending?.status, 'UNKNOWN');
  }
  for (const denial of [new ApiError('access lost', 403), new ApiError('changed incarnation', 409, 'PROJECT_INCAR_CHANGED'), new ApiError('changed identity', 409, 'SESSION_PRINCIPAL_CHANGED'), new ApiError('model disabled after admission', 409, 'PI_CONFIGURATION_REQUIRED'), new ApiError('new application gate', 400, 'CHANGED_APPLICATION_GATE')]) {
    let calls = 0;
    const session = new CommandSession(storage(), async () => { throw calls++ ? denial : new ApiError('timeout'); });
    await session.begin(state(), 'Launch', '/api/demo', { mode: 'pi' }); await session.retry(state());
    assert.equal(session.getSnapshot().pending?.status, 'UNKNOWN');
    session.dismissRejection(); assert.equal(session.getSnapshot().pending?.status, 'UNKNOWN');
  }
});

test('an acknowledged rejection permits deliberate fresh intent but not silent automatic replay', async () => {
  const sent: string[] = [];
  const session = new CommandSession(storage(), async command => { sent.push(command.id); throw new ApiError('stale revision', 409, 'STALE_STATE'); });
  await session.begin(state(), 'Launch', '/api/demo', { mode: 'pi' });
  assert.equal(session.getSnapshot().pending?.status, 'REJECTED');
  await assert.rejects(session.retry(state()), /Only an unconfirmed/);
  session.dismissRejection();
  await session.begin(state(), 'Launch', '/api/demo', { mode: 'pi' });
  assert.notEqual(sent[0], sent[1]);
});

test('persist-before-send prevents effects without a recoverable key and concurrent clicks cannot send twice', async () => {
  let calls = 0;
  const unavailable = new CommandSession({ ...storage(), setItem: () => { throw new Error('storage full'); } }, async () => { calls++; });
  await assert.rejects(unavailable.begin(state(), 'Launch', '/api/demo', { mode: 'pi' }), /storage full/); assert.equal(calls, 0);
  let finish!: () => void;
  const session = new CommandSession(storage(), () => { calls++; return new Promise<void>(resolve => { finish = resolve; }); });
  const first = session.begin(state(), 'Launch', '/api/demo', { mode: 'pi' });
  await assert.rejects(session.begin(state(), 'Launch', '/api/demo', { mode: 'pi' }), /Resolve the retained command/);
  assert.equal(calls, 1); finish(); assert.equal(await first, true);
});

test('local commands keep their supported route and closed body schema', () => {
  const local = state(); local.capabilities.deployment = false; delete local.session;
  const command = freezeCommand(local, 'Publish', '/api/publish', { proposalDigest: 'proposal', simulateLostResponse: true }, 'owned-id');
  assert.equal(command.path, '/api/publish');
  assert.deepEqual(JSON.parse(command.body), { proposalDigest: 'proposal', simulateLostResponse: true, commandId: 'owned-id' });
  assert.equal(command.headers['If-Platform-Principal'], undefined);
});

test('browser deadlines bound stalled headers and stalled response bodies without a second fetch', async () => {
  for (const phase of ['headers', 'body']) {
    let calls = 0; let signal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (_path, init) => { calls++; signal = init?.signal ?? undefined; return phase === 'headers' ? new Promise<Response>(() => {}) : new Response(new ReadableStream()); };
    await assert.rejects(request('/api/state', undefined, 15, fetcher), /before the deadline/);
    assert.equal(calls, 1); assert.equal(signal?.aborted, true);
  }
});

test('browser errors retain rejection code and recognize a login response', async () => {
  await assert.rejects(request('/api/state', undefined, 100, async () => Response.json({ error: { code: 'STALE_STATE', message: 'Stale' } }, { status: 409 })), { status: 409, code: 'STALE_STATE' });
  await assert.rejects(request('/api/state', undefined, 100, async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })), { status: 401 });
});

test('application proxy bounds the full authority body and retains complete successful bytes', async () => {
  for (const phase of ['headers', 'body']) {
    let signal: AbortSignal | undefined, cancelled = false;
    const fetcher = { fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return phase === 'headers' ? new Promise<Response>(() => {}) : new Response(new ReadableStream({ cancel: () => { cancelled = true; } }));
    } };
    await assert.rejects(authorityResponse(fetcher, 'https://owned.invalid', {}, 15), { status: 503 });
    assert.equal(signal?.aborted, true);
    if (phase === 'body') assert.equal(cancelled, true);
  }
  const response = await authorityResponse({ fetch: async () => Response.json({ recorded: true }, { status: 202 }) }, 'https://owned.invalid', {});
  assert.equal(response.status, 202); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(await response.json(), { recorded: true });
});
