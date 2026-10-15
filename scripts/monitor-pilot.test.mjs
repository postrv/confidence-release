// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, stat, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LIMITS, THRESHOLDS, UNOBSERVED, MonitorFault, parseJson, validateConfig, assessOperations, monitor,
  exitStatus, accessTransport, privateRead, correlate, retainRun } from './monitor-pilot.mjs';
const NOW = 1800000000000;
const bytes = value => Buffer.from(JSON.stringify(value));
const clone = value => structuredClone(value);
function config() { return { schemaVersion: 1, origin: 'https://monitor-owned.invalid', releaseDigest: 'sha256:' + 'a'.repeat(64),
  access: { tokenFile: '/private/tmp/monitor-owned.invalid-' + 'b'.repeat(64) + '-token', issuer: 'https://test.cloudflareaccess.com', audience: 'b'.repeat(64), principalId: 'https://test.cloudflareaccess.com#owned-human', tenantId: 'owned-test' },
  expectedMaintenance: false, expectedGate: 'CLOSED', requireDrained: true, samples: 1, intervalMs: 5000,
  projects: [{ scope: { schemaVersion: 1, tenantId: 'owned-test', projectId: 'owned-project', projectIncarnation: 'owned-incarnation' }, minimumRevision: '11' }] }; }
function session(c = config()) { return { principalId: c.access.principalId, tenantId: c.access.tenantId, credentialClass: 'human',
  authentication: { issuer: c.access.issuer, subject: 'owned-human', issuedAt: NOW / 1000 - 60, expiresAt: NOW / 1000 + 3600, authenticatedAt: null } }; }
function operations(c = config(), project = c.projects[0]) { return { schemaVersion: 1, scope: clone(project.scope), authorityRevision: '11', authorityObservedAt: NOW - 100, inspectionCompletedAt: NOW,
  atomicAcrossServices: false, readiness: 'UNVERIFIED', authority: { gate: 'CLOSED', maintenance: false, pendingOutbox: [], oldestPendingOutboxAgeSeconds: null, outboxAgeEvidence: 'EMPTY', cleanupPhases: [{ phase: 'TOMBSTONED', count: 2 }], unresolvedPublications: [],
    historyRows: ['records', 'events', 'outbox', 'evidence', 'receipts'].map(kind => ({ kind, count: 1 })), sqliteBytes: 4096,
    capacity: { scope: 'PER_PROJECT_AUTHORITY', status: 'NORMAL', recordsRows: 1, sqliteBytes: 4096, alertDimensions: [], stopDimensions: [], thresholds: clone(THRESHOLDS), newWorkAdmission: 'OPEN', recoveryWritesMayExceedThreshold: true },
    maximumBudgetMicroUnits: '100000', reservedBudgetMicroUnits: '0', settledBudgetMicroUnits: '100000' },
  evaluator: { schemaVersion: 1, scope: clone(project.scope), scheduler: { queued: 0, active: 0, oldestQueuedAgeSeconds: null, queuedAgeEvidence: 'EMPTY' }, generations: [], recoveryEvents: [], recoveryEventCoverage: 'BOUNDED_RECENT_ONLY' }, unobserved: ['projectionLag', 'deadLetterBacklog', 'providerSpend', 'containerResourceReturn'] }; }
function assess(body, c = config(), at = NOW) { return assessOperations(body, c, c.projects[0], at); }
function finding(body, code, c = config()) { return assess(body, c).findings.find(row => row.code === code); }
function capacity(body, records, size = 4096) { const a = body.authority, c = a.capacity; a.historyRows[0].count = c.recordsRows = records; a.sqliteBytes = c.sqliteBytes = size;
  c.alertDimensions = ['records', 'sqliteBytes'].filter(key => (key === 'records' ? records : size) >= THRESHOLDS[key].alert);
  c.stopDimensions = ['records', 'sqliteBytes'].filter(key => (key === 'records' ? records : size) >= THRESHOLDS[key].stop);
  c.status = c.stopDimensions.length ? 'STOP' : c.alertDimensions.length ? 'ALERT' : 'NORMAL'; c.newWorkAdmission = c.stopDimensions.length ? 'STOPPED' : 'OPEN'; }
function generation(body, age = 0) { const g = { jobKey: 'c'.repeat(64), inspection: 'OBSERVED', state: { phase: 'RUNNING', deadline: NOW - age * 1000 + 30000,
  terminationObserved: false, fixtureClosed: false, callbackFrozenAt: null, callbackDelivered: false } }; body.evaluator.scheduler.active = 1; body.evaluator.generations = [g]; return g.state; }
const run = (body = operations(), c = config(), options = {}) => monitor(c, async path => ({ status: 200, bytes: bytes(path === '/api/session' ? session(c) : body) }), { now: () => NOW, ...options });
async function temporary(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'confidence-monitor-test-'))); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('fresh scoped observations stay explicitly incomplete; retained report never claims production readiness', async () => {
  const report = await run(); assert.equal(report.status, 'PASS_SCOPED'); assert.equal(exitStatus(report.status), 0); assert.equal(report.readiness, 'UNVERIFIED');
  assert.deepEqual(report.unobserved, UNOBSERVED); assert.equal(report.authenticatedHuman, true); assert.equal(report.reads.length, 2);
  assert.equal(report.remoteMutations + report.modelCalls + report.notifications + report.automaticRetries, 0);
  assert.equal(report.allAuthorizedReadLatencyMs.samples, 2); assert.ok(report.completeTargets.includes('SESSION')); assert.ok(report.completeTargets.includes('RUN'));
  const text = JSON.stringify(report); for (const secret of [config().origin, config().access.principalId, config().access.tokenFile, 'owned-project', 'owned-incarnation']) assert.ok(!text.includes(secret));
});

test('inclusive capacity thresholds and inconsistent/old runtime responses cannot become green', () => {
  for (const [n, severity] of [[9999, null], [10000, 'ALERT'], [19999, 'ALERT'], [20000, 'STOP']]) {
    const body = operations(); capacity(body, n); assert.equal(finding(body, 'AUTHORITY_CAPACITY')?.severity ?? null, severity);
  }
  for (const [size, severity] of [[52428799, null], [52428800, 'ALERT'], [104857599, 'ALERT'], [104857600, 'STOP']]) {
    const body = operations(); capacity(body, 1, size); assert.equal(finding(body, 'AUTHORITY_CAPACITY')?.severity ?? null, severity);
  }
  for (const change of [b => delete b.authority.capacity, b => b.authority.capacity.newWorkAdmission = 'STOPPED', b => b.authority.capacity.thresholds.records.stop++, b => b.authority.capacity.recordsRows++]) {
    const body = operations(); change(body); assert.ok(assess(body).findings.some(row => row.severity === 'UNKNOWN'));
  }
});

test('outbox and queue age/count boundaries preserve pending identities; unknown ages stop', () => {
  const c = config(); c.requireDrained = false;
  for (const prefix of ['OUTBOX', 'QUEUE']) for (const [age, severity] of [[59, null], [60, 'ALERT'], [119, 'ALERT'], [120, 'STOP']]) {
    const b = operations(); if (prefix === 'OUTBOX') Object.assign(b.authority, { pendingOutbox: [{ kind: 'projection', count: 1 }], oldestPendingOutboxAgeSeconds: age, outboxAgeEvidence: 'RECORDED' });
    else Object.assign(b.evaluator.scheduler, { queued: 1, oldestQueuedAgeSeconds: age, queuedAgeEvidence: 'RECORDED' });
    assert.equal(finding(b, prefix + '_AGE', c)?.severity ?? null, severity);
  }
  for (const [queued, severity] of [[7, null], [8, 'ALERT'], [15, 'ALERT'], [16, 'STOP']]) { const b = operations(); Object.assign(b.evaluator.scheduler, { queued, oldestQueuedAgeSeconds: 0, queuedAgeEvidence: 'RECORDED' }); assert.equal(finding(b, 'QUEUE_COUNT', c)?.severity ?? null, severity); }
  for (const evidence of ['EMPTY', 'LEGACY_UNKNOWN', 'INVALID_TIMESTAMP', 'not-safe']) {
    const b = operations(); Object.assign(b.authority, { pendingOutbox: [{ kind: 'projection', count: 1 }], outboxAgeEvidence: evidence }); assert.equal(finding(b, 'OUTBOX_AGE_UNKNOWN', c).severity, 'UNKNOWN');
    Object.assign(b.evaluator.scheduler, { queued: 1, queuedAgeEvidence: evidence }); assert.equal(finding(b, 'QUEUE_AGE_UNKNOWN', c).severity, 'UNKNOWN');
  }
  const b = operations(); b.authority.outboxAgeEvidence = 'RECORDED'; assert.ok(finding(b, 'OUTBOX_AGE_UNKNOWN'));
});

test('young active generations remain normal; occupied and callback ages have inclusive stop bounds', () => {
  const c = config(); c.requireDrained = false;
  assert.equal(assessOperations((() => { const b = operations(); generation(b, 1); return b; })(), c, c.projects[0], NOW).findings.length, 0);
  for (const [age, severity] of [[59, null], [60, 'ALERT'], [119, 'ALERT'], [120, 'STOP']]) {
    const b = operations(); generation(b, age); assert.equal(finding(b, 'GENERATION_OCCUPIED', c)?.severity ?? null, severity);
    const g = b.evaluator.generations[0].state; g.callbackFrozenAt = NOW - age * 1000; assert.equal(finding(b, 'CALLBACK_UNACKNOWLEDGED', c)?.severity ?? null, severity);
  }
  for (const phase of ['STOPPED', 'STOP_REQUESTED']) { const b = operations(); generation(b).phase = phase; assert.ok(finding(b, 'CALLBACK_AGE_UNKNOWN', c)); }
  for (const changed of ['terminationObserved', 'fixtureClosed', 'callbackDelivered']) {
    const b = operations(), g = generation(b); Object.assign(g, { phase: 'STOPPED', terminationObserved: true, fixtureClosed: true, callbackDelivered: true, callbackFrozenAt: NOW - 1000 }); g[changed] = false;
    assert.ok(finding(b, 'GENERATION_NOT_DRAINED'));
  }
});

test('non-atomic missing generation, unknown inspection and partial drain are never interpreted as physical return', async () => {
  const changes = [b => b.evaluator = { inspection: 'UNKNOWN' }, b => b.evaluator.scope.projectIncarnation = 'different', b => b.evaluator.scheduler.active = 1,
    b => { generation(b); b.evaluator.generations[0].inspection = 'UNKNOWN'; }, b => generation(b).phase = 'MISSING', b => generation(b).deadline = NOW + 31001,
    b => { b.authority.cleanupPhases = [{ phase: 'RECOVERY_HOLD', count: 1 }]; }, b => b.authority.unresolvedPublications = [{ id: 'private-id', phase: 'AMBIGUOUS' }], b => b.authority.reservedBudgetMicroUnits = '1'];
  for (const change of changes) { const body = operations(); change(body); const r = await run(body); assert.notEqual(r.status, 'PASS_SCOPED'); assert.equal(r.stopNewWorkRecommended, true); assert.ok(!JSON.stringify(r).includes('private-id')); }
});

test('sanitized retained old-DO maintenance mismatch and missing capacity fixture remains actionable', async () => {
  // Structural reproduction of retained rollout evidence: HTTP 200 with the old false maintenance flag.
  const c = config(); c.expectedMaintenance = true; const b = operations(); delete b.authority.capacity;
  const r = await run(b, c); assert.equal(r.status, 'UNKNOWN'); assert.ok(r.findings.some(row => row.code === 'RUNTIME_FLAG_MISMATCH' && row.severity === 'STOP'));
  assert.ok(r.findings.some(row => row.code === 'CAPACITY_RUNTIME_UNVERIFIED')); assert.equal(r.reads[1].httpStatus, 200);
});

test('scope, monotonic revision, freshness and malformed budget counters reject before healthy metrics', async () => {
  for (const change of [b => b.scope.projectIncarnation = 'other', b => b.authorityRevision = '10', b => b.authorityRevision = '01', b => b.authorityObservedAt = NOW - 30001,
    b => b.inspectionCompletedAt = NOW + 1001, b => b.inspectionCompletedAt = NOW - 101, b => b.authorityObservedAt = -1, b => b.readiness = 'VERIFIED', b => b.atomicAcrossServices = true]) {
    const b = operations(); change(b); assert.equal((await run(b)).status, 'UNKNOWN');
  }
  for (const field of ['maximumBudgetMicroUnits', 'reservedBudgetMicroUnits', 'settledBudgetMicroUnits']) for (const value of [-1, '01', '-1', '1.2', '18446744073709551616', null]) {
    const b = operations(); b.authority[field] = value; assert.ok(finding(b, 'BUDGET_COUNTERS_UNKNOWN'));
  }
  const c = config(); c.samples = 2; let revision = '12';
  const r = await monitor(c, async path => { if (path === '/api/session') return { status: 200, bytes: bytes(session(c)) }; const b = operations(); b.authorityRevision = revision; revision = '11'; return { status: 200, bytes: bytes(b) }; }, { now: () => NOW, wait: async () => {} });
  assert.equal(r.status, 'UNKNOWN'); assert.ok(r.findings.some(row => row.code === 'SCOPE_OR_REVISION_UNVERIFIED'));
});

test('human server session verification precedes operations, with expiry, timestamp and identity constraints', async () => {
  for (const change of [s => s.credentialClass = 'agent', s => s.principalId += '-foreign', s => s.tenantId = 'foreign', s => s.authentication.issuer = 'https://other.invalid',
    s => s.authentication.issuedAt = NOW / 1000 + 2, s => s.authentication.authenticatedAt = NOW / 1000 + 2, s => s.authentication.expiresAt = NOW / 1000,
    s => s.authentication.issuedAt = NOW / 1000 + 2, s => s.authentication.subject = 'foreign']) {
    const s = session(); change(s); let count = 0; const r = await monitor(config(), async path => { count++; assert.equal(path, '/api/session'); return { status: 200, bytes: bytes(s) }; }, { now: () => NOW }); assert.equal(count, 1); assert.equal(r.status, 'UNKNOWN'); assert.equal(r.authenticatedHuman, false);
  }
});

test('a valid older GET session is accepted; expiration during a finite run stops further reads', async () => {
  const c = config(); c.samples = 2; let now = NOW; let calls = 0;
  const s = session(); s.authentication.issuedAt = NOW / 1000 - 18000; s.authentication.authenticatedAt = NOW / 1000 - 18000; s.authentication.expiresAt = NOW / 1000 + 1;
  const r = await monitor(c, async path => { calls++; return { status: 200, bytes: bytes(path === '/api/session' ? s : operations()) }; }, { now: () => now, wait: async () => { now += 5000; } });
  assert.equal(calls, 2); assert.equal(r.status, 'UNKNOWN'); assert.ok(r.findings.some(row => row.code === 'HUMAN_SESSION_STALE'));
});

test('configuration bounds and exact allowlist are rejected before any reads', async () => {
  for (const change of [c => c.origin += '/', c => c.origin = 'http://localhost', c => c.projects = [], c => c.projects.push(clone(c.projects[0])), c => c.samples = 7,
    c => c.intervalMs = 4999, c => c.access.tokenFile = 'relative', c => c.projects[0].scope.projectId = '../wrong', c => c.projects[0].scope.tenantId = 'foreign', c => c.extra = 'unsafe']) {
    const c = config(); change(c); let reads = 0; await assert.rejects(monitor(c, async () => { reads++; }), MonitorFault); assert.equal(reads, 0);
  }
});

test('strict JSON rejects duplicate escaped keys, trailing values, invalid UTF-8 and excessive depth', () => {
  for (const raw of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":2}}', '[1,]', '{}{}', 'truex', '{"a":"bad\n"}', '['.repeat(33) + '0' + ']'.repeat(33)]) assert.throws(() => parseJson(Buffer.from(raw)), MonitorFault);
  assert.throws(() => parseJson(Buffer.from([0xff])), MonitorFault); assert.deepEqual(parseJson(Buffer.from('{"quote":"\\\"","a":[null,true,-2.4e3]}')), { quote: '"', a: [null, true, -2400] });
});

test('deadline, oversized body, scope conflict and failures stay UNKNOWN without retry or raw error leakage', async () => {
  const secret = 'PRIVATE_SENTINEL_SHOULD_NOT_ESCAPE';
  for (const transport of [async () => { throw Error(secret); }, async () => { throw new MonitorFault(secret); }, async () => ({ status: 409, bytes: bytes({ error: secret }) }),
    async () => ({ status: 404, bytes: bytes({ error: secret }) }), async () => ({ status: 200, bytes: Buffer.alloc(LIMITS.responseBytes + 1) }), async () => ({ status: 200, bytes: Buffer.from('{"a":1,"a":2}') })]) {
    let calls = 0; const r = await monitor(config(), async (...args) => { calls++; return transport(...args); }, { now: () => NOW }); assert.equal(calls, 1); assert.equal(r.status, 'UNKNOWN'); assert.ok(!JSON.stringify(r).includes(secret));
  }
  let calls = 0, signal; const r = await monitor(config(), (_path, abort) => { calls++; signal = abort; return new Promise(() => {}); }, { requestMs: 10, now: () => NOW });
  assert.equal(calls, 1); assert.equal(signal.aborted, true); assert.equal(r.status, 'UNKNOWN'); assert.equal(r.findings[0].code, 'REQUEST_DEADLINE');
});

test('hard total elapsed and exact maximum sample/request bounds apply across project reads', async () => {
  const c = config(); c.samples = 6; c.projects = Array.from({ length: 4 }, (_, i) => ({ scope: { ...c.projects[0].scope, projectId: 'project-' + i }, minimumRevision: '11' })); let calls = 0, clock = 0;
  const r = await monitor(c, async path => { calls++; const project = c.projects.find(p => path.includes('/' + p.scope.projectId + '/')); return { status: 200, bytes: bytes(path === '/api/session' ? session(c) : operations(c, project)) }; }, { now: () => NOW, monotonic: () => clock, wait: async ms => { clock += ms; } });
  assert.equal(r.status, 'PASS_SCOPED'); assert.equal(calls, 25); assert.ok(calls <= LIMITS.requests); assert.equal(r.reads.length, 25); assert.equal(r.allAuthorizedReadLatencyMs.samples, 25);
  let reads = 0; const blocked = await monitor(config(), async path => { reads++; clock += 20; return { status: 200, bytes: bytes(path === '/api/session' ? session() : operations()) }; }, { now: () => NOW, monotonic: () => clock, overallMs: 10 });
  assert.equal(reads, 1); assert.equal(blocked.status, 'UNKNOWN'); assert.ok(blocked.findings.some(f => f.code === 'RUN_BOUND'));
});

test('Access adapter pins only GET origin/path/principal/incarnation, refuses redirects and bounds streamed bytes', async t => {
  const dir = await temporary(t), c = config(); c.access.tokenFile = join(dir, 'monitor-owned.invalid-' + 'b'.repeat(64) + '-token'); const token = 'e30.' + Buffer.from(JSON.stringify({ iss: c.access.issuer, aud: [c.access.audience], exp: Math.floor(Date.now() / 1000) + 1000 })).toString('base64url') + '.owned_signature'; await writeFile(c.access.tokenFile, token, { mode: 0o600 });
  let calls = 0; const access = await accessTransport(c, async (url, init) => { calls++; assert.equal(url, c.origin + '/v1/projects/owned-project/operations'); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.headers['CF-Access-Token'], token); assert.equal(init.headers['If-Platform-Principal'], c.access.principalId); assert.equal(init.headers['If-Platform-Incarnation'], 'owned-incarnation'); return new Response('{}'); });
  for (const path of ['/v1/projects/other/operations', '/v1/projects/owned-project/operations?x=1', c.origin + '/api/session', '/api/session#x', '/api/commands']) await assert.rejects(access.request(path), /READ_SCOPE_DENIED/);
  assert.equal(calls, 0); await access.request('/v1/projects/owned-project/operations'); assert.equal(calls, 1); access.close(); await assert.rejects(access.request('/api/session'), /READ_SCOPE_DENIED/);
  const oversized = await accessTransport(c, async () => new Response(Buffer.alloc(LIMITS.responseBytes + 1))); await assert.rejects(oversized.request('/api/session'), /RESPONSE_BOUND/); oversized.close();
  const redirect = await accessTransport(c, async (_url, init) => { assert.equal(init.redirect, 'error'); return new Response('not-json', { status: 302, headers: { location: 'https://foreign.invalid' } }); }); const r = await monitor(c, redirect.request, { now: () => NOW }); assert.equal(r.status, 'UNKNOWN'); assert.equal(r.reads[0].httpStatus, 302); redirect.close();
});

test('headers followed by a stalled response body still meet the read deadline', async t => {
  const dir = await temporary(t), c = config(); c.access.tokenFile = join(dir, 'monitor-owned.invalid-' + 'b'.repeat(64) + '-token'); await writeFile(c.access.tokenFile, 'e30.' + Buffer.from(JSON.stringify({ iss: c.access.issuer, aud: c.access.audience, exp: Math.floor(Date.now() / 1000) + 1000 })).toString('base64url') + '.owned_signature', { mode: 0o600 });
  const access = await accessTransport(c, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([123])); } })));
  const r = await monitor(c, access.request, { requestMs: 10, now: () => NOW }); access.close(); assert.equal(r.findings[0].code, 'REQUEST_DEADLINE'); assert.equal(r.status, 'UNKNOWN');
});

test('private cache rejects broad permissions/symlinks and never attempts login or credential generation', async t => {
  const dir = await temporary(t), file = join(dir, 'monitor-owned.invalid-' + 'b'.repeat(64) + '-token'); await writeFile(file, 'owned', { mode: 0o600 }); assert.equal((await privateRead(file, 16)).toString(), 'owned');
  await chmod(file, 0o644); await assert.rejects(privateRead(file, 16), /PRIVATE_FILE_REQUIRED/); await chmod(file, 0o600);
  const link = join(dir, 'link'); await symlink(file, link); await assert.rejects(privateRead(link, 16), /PRIVATE_FILE_REQUIRED/);
  await assert.rejects(privateRead(file, 2), /PRIVATE_FILE_REQUIRED/);
  const c = config(); c.access.tokenFile = file; let calls = 0; await assert.rejects(accessTransport(c, async () => { calls++; }), /EXISTING_ACCESS_CACHE_REQUIRED/); assert.equal(calls, 0);
});

test('durable safe alerts correlate recurrence/escalation, retain UNKNOWN and clear only a fully observed scope', async () => {
  const c = config(); c.requireDrained = false; const b = operations(); Object.assign(b.authority, { pendingOutbox: [{ kind: 'private-outbox-kind', count: 1 }], oldestPendingOutboxAgeSeconds: 60, outboxAgeEvidence: 'RECORDED' });
  const alert = await run(b, c), first = correlate(null, alert); assert.equal(first.alerts[0].severity, 'ALERT'); assert.equal(first.alerts[0].occurrences, 1);
  b.authority.oldestPendingOutboxAgeSeconds = 120; const stop = await run(b, c), second = correlate(first, stop); assert.equal(second.alerts.length, 1); assert.equal(second.alerts[0].severity, 'STOP'); assert.equal(second.alerts[0].occurrences, 2); assert.equal(second.alerts[0].correlationId, first.alerts[0].correlationId);
  const incomplete = await monitor(c, async path => path === '/api/session' ? { status: 200, bytes: bytes(session(c)) } : Promise.reject(Error('private-error')), { now: () => NOW });
  const third = correlate(second, incomplete); assert.equal(third.alerts.find(row => row.code === 'OUTBOX_AGE').condition, 'OPEN');
  const fourth = correlate(third, await run(operations(), c)); assert.ok(fourth.alerts.every(row => row.condition === 'CLEARED')); assert.ok(!JSON.stringify([first, second, third, fourth]).includes('private-outbox-kind'));
  const tampered = clone(first); tampered.alerts[0].credential = 'sentinel'; assert.throws(() => correlate(tampered, stop), /SPOOL_STATE_INVALID/);
});

test('spool durably retains each report and alert state privately, fences collision/interruption and bounds runs', async t => {
  const dir = await temporary(t), spool = join(dir, 'spool'), c = config(); let calls = 0;
  const retained = await retainRun(c, spool, async () => { calls++; return run(); }); assert.equal(calls, 1); assert.equal(retained.report.status, 'PASS_SCOPED');
  assert.equal((await stat(spool)).mode & 0o777, 0o700); const entries = await readdir(spool); assert.ok(!entries.includes('.monitor.lock'));
  for (const name of entries) assert.equal((await stat(join(spool, name))).mode & 0o777, 0o600);
  const raw = await readFile(join(spool, retained.reportName), 'utf8'); assert.ok(raw.includes('PASS_SCOPED')); assert.ok(!raw.includes(c.origin));
  await writeFile(join(spool, '.monitor.lock'), '{}', { mode: 0o600 }); await assert.rejects(retainRun(c, spool, async () => { calls++; }), /SPOOL_LOCK_PRESENT_OR_UNAVAILABLE/); assert.equal(calls, 1);
  const broken = join(dir, 'broken'); await assert.rejects(retainRun(c, broken, async () => { throw Error('private-crash'); }), /private-crash/); assert.ok((await readdir(broken)).includes('.monitor.lock'));
  const started = (await readdir(broken)).find(n => n.startsWith('run-')); assert.equal(JSON.parse(await readFile(join(broken, started))).status, 'STARTED_UNKNOWN');
  const full = join(dir, 'full'); await retainRun(c, full, () => run()); const statePath = join(full, 'alerts.json'), state = JSON.parse(await readFile(statePath)); state.sequence = LIMITS.runs; await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(retainRun(c, full, async () => { calls++; }), /SPOOL_REVIEW_REQUIRED/); assert.equal(calls, 1);
});

test('retention failure is never acknowledged as a successful monitoring run', async t => {
  const dir = await temporary(t), spool = join(dir, 'spool'); let writes = 0;
  await assert.rejects(retainRun(config(), spool, () => run(), { persist: async () => { if (++writes > 1) throw Error('injected-disk-failure'); } }), /injected-disk-failure/);
  assert.ok((await readdir(spool)).includes('.monitor.lock')); assert.equal(writes, 2);
});

test('CLI refuses missing explicit authorization flags before reading a cache or making requests', () => {
  const result = spawnSync(process.execPath, [new URL('./monitor-pilot.mjs', import.meta.url).pathname], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 3); assert.equal(result.stdout, ''); const summary = JSON.parse(result.stderr); assert.equal(summary.status, 'UNKNOWN'); assert.equal(summary.code, 'USAGE_REQUIRES_EXPLICIT_READ_ONLY_CONFIG_AND_PRIVATE_SPOOL');
});

test('an UNKNOWN target is not read again by later samples and cannot clear retained alerts', async () => {
  const c = config(); c.requireDrained = false; const b = operations(); Object.assign(b.authority, { pendingOutbox: [{ kind: 'projection', count: 1 }], oldestPendingOutboxAgeSeconds: 120, outboxAgeEvidence: 'RECORDED' });
  c.samples = 3; const prior = correlate(null, await run(b, c, { wait: async () => {} })); let calls = 0;
  const r = await monitor(c, async path => { calls++; return { status: path === '/api/session' ? 200 : 503, bytes: bytes(path === '/api/session' ? session(c) : { arbitrary: 'PRIVATE_SENTINEL' }) }; }, { now: () => NOW, wait: async () => {} });
  assert.equal(calls, 2); assert.equal(r.skippedUnknownTargetReads, 2); assert.equal(r.status, 'UNKNOWN'); assert.equal(r.automaticRetries, 0);
  assert.equal(correlate(prior, r).alerts.find(row => row.code === 'OUTBOX_AGE').condition, 'OPEN');
  assert.ok(!JSON.stringify(r).includes('PRIVATE_SENTINEL'));
});

test('lost alert state or retained-history mismatch fences the spool before any read', async t => {
  const dir = await temporary(t), c = config();
  for (const kind of ['lost-state', 'lost-history']) {
    const spool = join(dir, kind), retained = await retainRun(c, spool, () => run());
    await rm(join(spool, kind === 'lost-state' ? 'alerts.json' : retained.reportName));
    let calls = 0; await assert.rejects(retainRun(c, spool, async () => { calls++; return run(); }), /SPOOL_REVIEW_REQUIRED/); assert.equal(calls, 0);
  }
});

test('cache destination mismatch rejects before opening a credential or using fetch', async () => {
  for (const change of [c => c.origin = 'https://wrong-origin.invalid', c => c.access.tokenFile = '/private/tmp/monitor-owned.invalid-' + 'd'.repeat(64) + '-token']) {
    const c = config(); change(c); let calls = 0;
    await assert.rejects(accessTransport(c, async () => { calls++; }), /CACHE_DESTINATION_MISMATCH/); assert.equal(calls, 0);
  }
});

test('private special files are refused without a blocking open', { timeout: 2000 }, async t => {
  const dir = await temporary(t), fifo = join(dir, 'fifo'); const made = spawnSync('mkfifo', ['-m', '600', fifo], { encoding: 'utf8', timeout: 1000 });
  assert.equal(made.status, 0); await assert.rejects(privateRead(fifo, 128), /PRIVATE_FILE_REQUIRED/);
});

test('server recent-owner-session denial stays UNKNOWN, skips later samples and preserves retained alerts', async () => {
  const c = config(); c.samples = 3; c.requireDrained = false;
  const oldButValid = session(c); oldButValid.authentication.issuedAt = NOW / 1000 - 18000;
  const busy = operations(); Object.assign(busy.authority, { pendingOutbox: [{ kind: 'projection', count: 1 }], oldestPendingOutboxAgeSeconds: 120, outboxAgeEvidence: 'RECORDED' });
  const prior = correlate(null, await run(busy, c, { wait: async () => {} })); let calls = 0;
  const r = await monitor(c, async path => { calls++; return path === '/api/session' ? { status: 200, bytes: bytes(oldButValid) }
    : { status: 403, bytes: bytes({ error: { code: 'RECENT_SESSION_REQUIRED', message: 'PRIVATE_MESSAGE_SENTINEL' } }) }; }, { now: () => NOW, wait: async () => {} });
  assert.equal(r.authenticatedHuman, true); assert.equal(r.status, 'UNKNOWN'); assert.equal(calls, 2); assert.equal(r.skippedUnknownTargetReads, 2);
  assert.equal(r.findings[0].code, 'RECENT_SESSION_REQUIRED'); assert.match(r.findings[0].remediation, /Refresh the ordinary owner Access session outside this CLI/);
  assert.match(r.findings[0].remediation, /not proof of strict provider reauthentication/);
  assert.ok(!JSON.stringify(r).includes('PRIVATE_MESSAGE_SENTINEL'));
  const next = correlate(prior, r); assert.equal(next.alerts.find(row => row.code === 'OUTBOX_AGE').condition, 'OPEN');
  assert.equal(next.alerts.find(row => row.code === 'RECENT_SESSION_REQUIRED').condition, 'OPEN');
  assert.equal(correlate(next, r).alerts.find(row => row.code === 'RECENT_SESSION_REQUIRED').occurrences, 2);
});

test('only exact known HTTP403 error.code receives recent-session classification; raw and ambiguous errors stay generic', async () => {
  const variants = [
    { status: 403, bytes: bytes({ error: { code: 'RECENT_SESSION_REQUIRED_SUFFIX', message: 'PRIVATE_SENTINEL' } }) },
    { status: 403, bytes: bytes({ code: 'RECENT_SESSION_REQUIRED', message: 'PRIVATE_SENTINEL' }) },
    { status: 403, bytes: Buffer.from('{"error":{"code":"OTHER","code":"RECENT_SESSION_REQUIRED"}}') },
    { status: 403, bytes: bytes({ error: { code: { private: 'PRIVATE_SENTINEL' } } }) },
    { status: 403, bytes: Buffer.from('PRIVATE_SENTINEL') },
    { status: 401, bytes: bytes({ error: { code: 'RECENT_SESSION_REQUIRED', message: 'PRIVATE_SENTINEL' } }) },
  ];
  for (const denial of variants) {
    const r = await monitor(config(), async path => path === '/api/session' ? { status: 200, bytes: bytes(session()) } : denial, { now: () => NOW });
    assert.equal(r.status, 'UNKNOWN'); assert.equal(r.findings[0].code, 'ACCESS_OR_MEMBERSHIP_DENIED'); assert.ok(!JSON.stringify(r).includes('PRIVATE_SENTINEL'));
  }
});
