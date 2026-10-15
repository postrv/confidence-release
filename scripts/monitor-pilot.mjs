// SPDX-License-Identifier: Apache-2.0
// Finite, human-authorized operations reads. No provider credentials, mutations or notifications.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual as same } from 'node:util';

export const LIMITS = Object.freeze({ projects: 4, samples: 6, requests: 26, requestMs: 20000,
  overallMs: 180000, responseBytes: 131072, configBytes: 16384, spoolBytes: 262144,
  reportBytes: 131072, findings: 256, runs: 128, observationAgeMs: 30000 });
export const THRESHOLDS = Object.freeze({ records: { alert: 10000, stop: 20000 }, sqliteBytes: { alert: 52428800, stop: 104857600 } });
export const UNOBSERVED = Object.freeze(['projectionLag', 'deadLetterBacklog', 'providerSpend',
  'physicalContainerReturn', 'runnerDispatchOutcomes', 'modelCallReconciliation', 'R2RequestVolume', 'notificationDelivery', 'deployedReleaseIdentity', 'strictProviderReauthentication', 'providerSessionRevocation']);
const UINT64 = 18446744073709551615n;
const digest = value => 'sha256:' + createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const requireValue = (condition, code) => { if (!condition) throw new MonitorFault(code); };
const count = value => Number.isSafeInteger(value) && value >= 0;
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= UINT64;
const pin = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && same(Object.keys(value).sort(), [...expected].sort());
export class MonitorFault extends Error { constructor(code) { super(code); this.code = code; } }
const SAFE_CODES = new Set(('READ_UNAVAILABLE JSON_BOUND JSON_INVALID JSON_DEPTH JSON_DUPLICATE CONFIG_INVALID CONFIG_ORIGIN CONFIG_ACCESS CACHE_DESTINATION_MISMATCH CONFIG_PROJECTS CONFIG_SCOPE CONFIG_DUPLICATE_PROJECT HUMAN_SESSION_UNVERIFIED HUMAN_SESSION_STALE TIME_BOUND_INVALID FINDING_BOUND RUN_BOUND REQUEST_DEADLINE RESPONSE_BOUND ACCESS_OR_MEMBERSHIP_DENIED RECENT_SESSION_REQUIRED OPERATOR_SCOPE_CHANGED RUNTIME_METHOD_UNAVAILABLE HTTP_READ_UNAVAILABLE PRIVATE_FILE_REQUIRED PRIVATE_FILE_BOUND EXISTING_ACCESS_CACHE_REQUIRED READ_SCOPE_DENIED RESPONSE_BODY_REQUIRED LOCAL_REPORT_BOUND SPOOL_STATE_INVALID SPOOL_ALERT_BOUND PRIVATE_SPOOL_REQUIRED RUN_ID_INVALID SPOOL_LOCK_PRESENT_OR_UNAVAILABLE SPOOL_REVIEW_REQUIRED RUN_ID_REUSED USAGE_REQUIRES_EXPLICIT_READ_ONLY_CONFIG_AND_PRIVATE_SPOOL SCOPE_OR_REVISION_UNVERIFIED OBSERVATION_STALE_OR_INVALID AUTHORITY_SHAPE_UNKNOWN RUNTIME_FLAG_MISMATCH BUDGET_COUNTERS_UNKNOWN BUDGET_NOT_DRAINED CAPACITY_RUNTIME_UNVERIFIED CAPACITY_STATUS_INCONSISTENT AUTHORITY_CAPACITY OUTBOX_AGE_UNKNOWN OUTBOX_AGE OUTBOX_SHAPE_UNKNOWN OUTBOX_NOT_DRAINED CLEANUP_SHAPE_UNKNOWN CLEANUP_RECOVERY_HOLD CLEANUP_NOT_DRAINED PUBLICATION_SHAPE_UNKNOWN PUBLICATION_UNRESOLVED EVALUATOR_INSPECTION_UNKNOWN SCHEDULER_SHAPE_UNKNOWN QUEUE_AGE_UNKNOWN QUEUE_AGE QUEUE_COUNT EVALUATOR_NOT_DRAINED GENERATION_INVENTORY_UNKNOWN GENERATION_INSPECTION_UNKNOWN GENERATION_OCCUPIED CALLBACK_AGE_UNKNOWN CALLBACK_UNACKNOWLEDGED GENERATION_NOT_DRAINED').split(' '));
const safeError = error => error instanceof MonitorFault && SAFE_CODES.has(error.code) ? error.code : 'READ_UNAVAILABLE';

/** Strict JSON: reject duplicates (including escaped keys), excess depth, invalid UTF-8 and trailing data. */
export function parseJson(bytes) {
  requireValue(Buffer.isBuffer(bytes) && bytes.length <= LIMITS.spoolBytes, 'JSON_BOUND');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new MonitorFault('JSON_INVALID'); }
  let cursor = 0;
  const whitespace = () => { while (/[\x20\t\n\r]/.test(text[cursor] ?? '\0')) cursor++; };
  const string = () => {
    const start = cursor++; let escaped = false;
    while (cursor < text.length) { const char = text[cursor++]; if (char === '"' && !escaped) {
      try { return JSON.parse(text.slice(start, cursor)); } catch { throw new MonitorFault('JSON_INVALID'); }
    } if (char === '\\' && !escaped) escaped = true; else escaped = false; }
    throw new MonitorFault('JSON_INVALID');
  };
  const value = depth => {
    requireValue(depth <= 32, 'JSON_DEPTH'); whitespace(); const char = text[cursor];
    if (char === '"') return string();
    if (char === '{') {
      cursor++; whitespace(); const result = Object.create(null), seen = new Set();
      if (text[cursor] === '}') { cursor++; return result; }
      for (;;) { whitespace(); requireValue(text[cursor] === '"', 'JSON_INVALID'); const key = string();
        requireValue(!seen.has(key), 'JSON_DUPLICATE'); seen.add(key); whitespace(); requireValue(text[cursor++] === ':', 'JSON_INVALID');
        result[key] = value(depth + 1); whitespace(); const delimiter = text[cursor++]; if (delimiter === '}') return result;
        requireValue(delimiter === ',', 'JSON_INVALID'); }
    }
    if (char === '[') { cursor++; whitespace(); const result = []; if (text[cursor] === ']') { cursor++; return result; }
      for (;;) { result.push(value(depth + 1)); whitespace(); const delimiter = text[cursor++]; if (delimiter === ']') return result; requireValue(delimiter === ',', 'JSON_INVALID'); }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(cursor));
    requireValue(match, 'JSON_INVALID'); cursor += match[0].length; return JSON.parse(match[0]);
  };
  const result = value(0); whitespace(); requireValue(cursor === text.length, 'JSON_INVALID');
  // Return ordinary JSON objects so structural comparison has standard semantics; parsing above rejects duplicates.
  return JSON.parse(text);
}

export function validateConfig(config) {
  requireValue(keys(config, ['schemaVersion', 'origin', 'releaseDigest', 'access', 'expectedMaintenance', 'expectedGate', 'requireDrained', 'samples', 'intervalMs', 'projects']) && config.schemaVersion === 1, 'CONFIG_INVALID');
  let origin, issuer; try { origin = new URL(config.origin); issuer = new URL(config.access?.issuer); } catch { throw new MonitorFault('CONFIG_INVALID'); }
  requireValue(origin.protocol === 'https:' && origin.origin === config.origin && !origin.username && !origin.password && !origin.port
    && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname), 'CONFIG_ORIGIN');
  const access = config.access;
  requireValue(keys(access, ['tokenFile', 'issuer', 'audience', 'principalId', 'tenantId']) && isAbsolute(access.tokenFile)
    && access.tokenFile.length <= 1024 && issuer.protocol === 'https:' && issuer.origin === access.issuer && issuer.hostname.endsWith('.cloudflareaccess.com')
    && typeof access.audience === 'string' && /^[a-f0-9]{64}$/.test(access.audience) && typeof access.principalId === 'string'
    && access.principalId.startsWith(access.issuer + '#') && access.principalId.length <= 512 && id(access.tenantId), 'CONFIG_ACCESS');
  requireValue(basename(access.tokenFile) === origin.hostname + '-' + access.audience + '-token', 'CACHE_DESTINATION_MISMATCH');
  requireValue(pin(config.releaseDigest) && typeof config.expectedMaintenance === 'boolean' && ['OPEN', 'CLOSED'].includes(config.expectedGate)
    && typeof config.requireDrained === 'boolean' && Number.isInteger(config.samples) && config.samples >= 1 && config.samples <= LIMITS.samples
    && Number.isInteger(config.intervalMs) && config.intervalMs >= 5000 && config.intervalMs <= 30000, 'CONFIG_INVALID');
  requireValue(Array.isArray(config.projects) && config.projects.length >= 1 && config.projects.length <= LIMITS.projects, 'CONFIG_PROJECTS');
  const scopes = new Set();
  for (const project of config.projects) {
    requireValue(keys(project, ['scope', 'minimumRevision']) && keys(project.scope, ['schemaVersion', 'tenantId', 'projectId', 'projectIncarnation'])
      && project.scope.schemaVersion === 1 && project.scope.tenantId === access.tenantId && id(project.scope.projectId)
      && id(project.scope.projectIncarnation) && uint(project.minimumRevision), 'CONFIG_SCOPE');
    requireValue(!scopes.has(project.scope.projectId), 'CONFIG_DUPLICATE_PROJECT'); scopes.add(project.scope.projectId);
  }
  return config;
}
const targetDigest = (config, project) => digest(canonical([config.origin, project.scope]));
const configurationDigest = config => digest(canonical(config));

const REMEDIATION = Object.freeze({
  admission: 'Close new admission through the separately authorized operator flow. Preserve original command, job and publication identities; reconcile readback before any retry.',
  capacity: 'Keep new work stopped at the scoped storage threshold. Drain existing work and review retention/recovery; this monitor deletes nothing.',
  access: 'Obtain a fresh existing human Access session outside this monitor and verify current admin membership. Do not bypass provider or authority authentication.',
  ownerSession: 'Refresh the ordinary owner Access session outside this CLI and verify current owner membership, then request a new bounded observation. Retain this UNKNOWN result; refresh is not proof of strict provider reauthentication.',
  runtime: 'Keep admission closed, verify the deployed release and wait for an explicitly requested fresh observation. HTTP success alone does not prove Durable Object adoption.',
  evidence: 'Retain this UNKNOWN result and inspect original durable evidence. Never create replacement work or infer completion from absent observations.',
});
export function assessOperations(body, config, project, now, minimumRevision = project.minimumRevision) {
  const target = targetDigest(config, project), findings = [];
  const add = (code, severity = 'STOP', action = 'admission', identity = '') => findings.push({ target, code, severity, remediation: REMEDIATION[action], correlationId: digest(canonical([target, code, identity])) });
  const unknown = code => add(code, 'UNKNOWN', 'evidence');
  const result = metrics => ({ target, findings, metrics, complete: !findings.some(row => row.severity === 'UNKNOWN') });
  if (!body || body.schemaVersion !== 1 || !same(body.scope, project.scope) || !uint(body.authorityRevision)
    || BigInt(body.authorityRevision) < BigInt(minimumRevision)) { unknown('SCOPE_OR_REVISION_UNVERIFIED'); return result(null); }
  if (!count(body.authorityObservedAt) || !count(body.inspectionCompletedAt) || body.authorityObservedAt > now + 1000
    || body.inspectionCompletedAt > now + 1000 || body.inspectionCompletedAt < body.authorityObservedAt
    || now - body.authorityObservedAt > LIMITS.observationAgeMs || body.atomicAcrossServices !== false || body.readiness !== 'UNVERIFIED') {
    unknown('OBSERVATION_STALE_OR_INVALID'); return result(null);
  }
  const a = body.authority, e = body.evaluator;
  if (!object(a)) { unknown('AUTHORITY_SHAPE_UNKNOWN'); return result(null); }
  if (a.maintenance !== config.expectedMaintenance || a.gate !== config.expectedGate) add('RUNTIME_FLAG_MISMATCH', 'STOP', 'runtime');
  if (![a.maximumBudgetMicroUnits, a.reservedBudgetMicroUnits, a.settledBudgetMicroUnits].every(uint)
    || BigInt(a.reservedBudgetMicroUnits) + BigInt(a.settledBudgetMicroUnits) > BigInt(a.maximumBudgetMicroUnits)) unknown('BUDGET_COUNTERS_UNKNOWN');
  else if (config.requireDrained && a.reservedBudgetMicroUnits !== '0') add('BUDGET_NOT_DRAINED');
  const c = a.capacity, history = a.historyRows;
  if (!c || !Array.isArray(history) || history.length !== 5 || new Set(history.map(row => row.kind)).size !== 5
    || !history.every(row => ['records', 'events', 'outbox', 'evidence', 'receipts'].includes(row.kind) && count(row.count))
    || !count(c.recordsRows) || !count(c.sqliteBytes) || c.recordsRows !== history.find(row => row.kind === 'records')?.count
    || c.sqliteBytes !== a.sqliteBytes || c.scope !== 'PER_PROJECT_AUTHORITY' || !same(c.thresholds, THRESHOLDS) || c.recoveryWritesMayExceedThreshold !== true) unknown('CAPACITY_RUNTIME_UNVERIFIED');
  else {
    const values = { records: c.recordsRows, sqliteBytes: c.sqliteBytes }, alerts = Object.keys(values).filter(key => values[key] >= THRESHOLDS[key].alert), stops = Object.keys(values).filter(key => values[key] >= THRESHOLDS[key].stop);
    if (c.status !== (stops.length ? 'STOP' : alerts.length ? 'ALERT' : 'NORMAL') || c.newWorkAdmission !== (stops.length ? 'STOPPED' : 'OPEN')
      || !same(c.alertDimensions, alerts) || !same(c.stopDimensions, stops)) unknown('CAPACITY_STATUS_INCONSISTENT');
    if (alerts.length) add('AUTHORITY_CAPACITY', stops.length ? 'STOP' : 'ALERT', 'capacity');
  }
  function ageCondition(n, age, evidence, prefix) {
    if (!count(n) || n === 0 && (age !== null || evidence !== 'EMPTY') || n > 0 && (evidence !== 'RECORDED' || !count(age))) { unknown(prefix + '_AGE_UNKNOWN'); return; }
    if (n && age >= 60) add(prefix + '_AGE', age >= 120 ? 'STOP' : 'ALERT');
  }
  let pending = null;
  if (!Array.isArray(a.pendingOutbox) || a.pendingOutbox.length > 32 || !a.pendingOutbox.every(row => object(row) && typeof row.kind === 'string' && row.kind.length <= 128 && count(row.count) && row.count > 0)
    || new Set(a.pendingOutbox.map(row => row.kind)).size !== a.pendingOutbox.length) unknown('OUTBOX_SHAPE_UNKNOWN');
  else { pending = a.pendingOutbox.reduce((sum, row) => sum + row.count, 0); ageCondition(pending, a.oldestPendingOutboxAgeSeconds, a.outboxAgeEvidence, 'OUTBOX'); if (config.requireDrained && pending) add('OUTBOX_NOT_DRAINED'); }
  if (!Array.isArray(a.cleanupPhases) || a.cleanupPhases.length > 32 || !a.cleanupPhases.every(row => object(row) && ['STOP_REQUESTED', 'CREDENTIALS_REVOKED', 'ARCHIVE_VERIFIED', 'DELETE_MAY_HAVE_DISPATCHED', 'TOMBSTONED', 'RECOVERY_HOLD'].includes(row.phase) && count(row.count) && row.count > 0)) unknown('CLEANUP_SHAPE_UNKNOWN');
  else { if (a.cleanupPhases.some(row => row.phase === 'RECOVERY_HOLD')) add('CLEANUP_RECOVERY_HOLD');
    if (config.requireDrained && a.cleanupPhases.some(row => row.phase !== 'TOMBSTONED')) add('CLEANUP_NOT_DRAINED'); }
  if (!Array.isArray(a.unresolvedPublications) || a.unresolvedPublications.length > 2) unknown('PUBLICATION_SHAPE_UNKNOWN');
  else if (a.unresolvedPublications.length) add('PUBLICATION_UNRESOLVED');
  let queued = null, active = null;
  if (!e || e.inspection === 'UNKNOWN' || e.schemaVersion !== 1 || !same(e.scope, project.scope)) unknown('EVALUATOR_INSPECTION_UNKNOWN');
  else {
    const s = e.scheduler;
    if (!s || !count(s.queued) || !count(s.active) || s.queued + s.active > 256 || s.active > 2) unknown('SCHEDULER_SHAPE_UNKNOWN');
    else { queued = s.queued; active = s.active; ageCondition(queued, s.oldestQueuedAgeSeconds, s.queuedAgeEvidence, 'QUEUE');
      if (queued >= 8) add('QUEUE_COUNT', queued >= 16 ? 'STOP' : 'ALERT'); if (config.requireDrained && (queued || active)) add('EVALUATOR_NOT_DRAINED'); }
    if (!Array.isArray(e.generations) || e.generations.length > 2 || active === null || e.generations.length !== active
      || new Set(e.generations.map(row => row.jobKey)).size !== e.generations.length) unknown('GENERATION_INVENTORY_UNKNOWN');
    else for (const generation of e.generations) {
      const g = generation.state;
      if (!/^[a-f0-9]{64}$/.test(generation.jobKey ?? '') || generation.inspection !== 'OBSERVED' || !object(g)
        || !['RESERVED', 'START_MAY_HAVE_DISPATCHED', 'RUNNING', 'STOP_REQUESTED', 'STOPPED'].includes(g.phase)
        || !count(g.deadline) || g.deadline > now + 31000 || !['terminationObserved', 'fixtureClosed', 'callbackDelivered'].every(key => typeof g[key] === 'boolean')) { unknown('GENERATION_INSPECTION_UNKNOWN'); continue; }
      const identity = digest(generation.jobKey), age = Math.max(0, Math.floor((now - (g.deadline - 30000)) / 1000));
      if (age >= 60) add('GENERATION_OCCUPIED', age >= 120 ? 'STOP' : 'ALERT', 'admission', identity);
      if (g.callbackFrozenAt !== null) {
        if (!count(g.callbackFrozenAt) || g.callbackFrozenAt > now + 1000) unknown('CALLBACK_AGE_UNKNOWN');
        else if (!g.callbackDelivered && now - g.callbackFrozenAt >= 60000) add('CALLBACK_UNACKNOWLEDGED', now - g.callbackFrozenAt >= 120000 ? 'STOP' : 'ALERT', 'admission', identity);
      } else if (!g.callbackDelivered && ['STOP_REQUESTED', 'STOPPED'].includes(g.phase)) unknown('CALLBACK_AGE_UNKNOWN');
      // Delivered callbacks alone cannot release either the fixture or the native generation.
      if (config.requireDrained && !(g.terminationObserved && g.fixtureClosed && g.callbackDelivered)) add('GENERATION_NOT_DRAINED', 'STOP', 'admission', identity);
    }
  }
  return result({ revision: body.authorityRevision, authorityObservedAt: body.authorityObservedAt, inspectionCompletedAt: body.inspectionCompletedAt,
    pendingOutbox: pending, queued, active, recordsRows: count(c?.recordsRows) ? c.recordsRows : null, sqliteBytes: count(c?.sqliteBytes) ? c.sqliteBytes : null,
    reservedBudgetMicroUnits: uint(a.reservedBudgetMicroUnits) ? a.reservedBudgetMicroUnits : null });
}

function verifySession(session, config, now) {
  const a = session?.authentication;
  requireValue(session?.credentialClass === 'human' && session.principalId === config.access.principalId && session.tenantId === config.access.tenantId
    && a?.issuer === config.access.issuer && config.access.principalId === a.issuer + '#' + a.subject, 'HUMAN_SESSION_UNVERIFIED');
  requireValue(count(a.issuedAt) && count(a.expiresAt) && a.issuedAt * 1000 <= now + 1000
    && a.expiresAt * 1000 > now && a.expiresAt > a.issuedAt
    && (a.authenticatedAt == null || count(a.authenticatedAt) && a.authenticatedAt * 1000 <= now + 1000), 'HUMAN_SESSION_STALE');
  return a.expiresAt * 1000;
}
async function bounded(operation, timeoutMs, code) {
  const controller = new AbortController(); let timer;
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MonitorFault(code)); }, timeoutMs); })]); }
  finally { clearTimeout(timer); controller.abort(); }
}
const statusOf = findings => findings.some(row => row.severity === 'UNKNOWN') ? 'UNKNOWN' : findings.some(row => row.severity === 'STOP') ? 'STOP' : findings.length ? 'ALERT' : 'PASS_SCOPED';
export const exitStatus = status => ({ PASS_SCOPED: 0, ALERT: 1, STOP: 2, UNKNOWN: 3 })[status] ?? 3;
const percentile = (values, p) => values.length ? [...values].sort((a,b) => a-b)[Math.ceil(values.length * p) - 1] : null;

/** Transport is injected in tests. A timed-out read is never automatically repeated. */
export async function monitor(config, transport, { now = Date.now, monotonic = () => performance.now(), wait = ms => new Promise(r => setTimeout(r, ms)), requestMs = LIMITS.requestMs, overallMs = LIMITS.overallMs } = {}) {
  validateConfig(config); requireValue(requestMs > 0 && requestMs <= LIMITS.requestMs && overallMs > 0 && overallMs <= LIMITS.overallMs, 'TIME_BOUND_INVALID');
  const started = now(), clock = monotonic(), findings = new Map(), reads = [], completeTargets = new Set(), latencies = [];
  const report = { schemaVersion: 1, kind: 'BOUNDED_NATIVE_OPERATIONS_MONITOR', status: 'UNKNOWN', configurationDigest: configurationDigest(config), declaredReleaseDigest: config.releaseDigest,
    startedAt: started, completedAt: null, limits: LIMITS, requestedSamples: config.samples, reads, findings: [], completeTargets: [],
    unobserved: UNOBSERVED, readiness: 'UNVERIFIED', remoteMutations: 0, modelCalls: 0, automaticRetries: 0, notifications: 0,
    authenticationBasis: 'SERVER_VERIFIED_UNEXPIRED_HUMAN_GET_ONLY', skippedUnknownTargetReads: 0, atomicAcrossServices: false, generationAgeBasis: 'CURRENT_RUNTIME_DEADLINE_MINUS_30000_MS', authenticatedHuman: false };
  const add = finding => { requireValue(findings.size < LIMITS.findings || findings.has(finding.correlationId), 'FINDING_BOUND'); const old = findings.get(finding.correlationId); if (!old || exitStatus(finding.severity) >= exitStatus(old.severity)) findings.set(finding.correlationId, finding); };
  const failed = (target, code, action = 'evidence') => add({ target, code, severity: 'UNKNOWN', remediation: REMEDIATION[code === 'RECENT_SESSION_REQUIRED' ? 'ownerSession' : action], correlationId: digest(canonical([target, code, ''])) });
  const request = async (path, target) => {
    const start = monotonic(), remaining = overallMs - (start - clock);
    requireValue(remaining > 0 && reads.length < LIMITS.requests, 'RUN_BOUND');
    const read = { target, requestIndex: reads.length + 1, outcome: 'UNKNOWN', httpStatus: null, bytes: null, latencyMs: null }; reads.push(read);
    try { const response = await bounded(signal => transport(path, signal), Math.max(1, Math.min(requestMs, remaining)), 'REQUEST_DEADLINE');
      requireValue(response && Number.isInteger(response.status) && Buffer.isBuffer(response.bytes) && response.bytes.length <= LIMITS.responseBytes, 'RESPONSE_BOUND');
      read.httpStatus = response.status; read.bytes = response.bytes.length;
      let denial = response.status === 401 || response.status === 403 ? 'ACCESS_OR_MEMBERSHIP_DENIED' : response.status === 409 ? 'OPERATOR_SCOPE_CHANGED' : response.status === 404 || response.status === 501 ? 'RUNTIME_METHOD_UNAVAILABLE' : 'HTTP_READ_UNAVAILABLE';
      if (response.status === 403) {
        // Whitelist this one known server code; never retain arbitrary error text or payloads.
        try { if (parseJson(response.bytes)?.error?.code === 'RECENT_SESSION_REQUIRED') denial = 'RECENT_SESSION_REQUIRED'; } catch { /* Malformed/ambiguous bodies retain the generic denial. */ }
      }
      requireValue(response.status === 200, denial);
      const value = parseJson(response.bytes); read.outcome = 'OBSERVED'; return value;
    } finally { read.latencyMs = Math.max(0, Math.round(monotonic() - start)); latencies.push(read.latencyMs); }
  };
  try {
    let expiresAt;
    try { const session = await request('/api/session', 'SESSION'); expiresAt = verifySession(session, config, now()); report.authenticatedHuman = true; completeTargets.add('SESSION'); }
    catch (error) { failed('SESSION', safeError(error), 'access'); return finish(); }
    const revisions = new Map(config.projects.map(project => [targetDigest(config, project), project.minimumRevision]));
    const complete = new Map(config.projects.map(project => [targetDigest(config, project), true]));
    for (let sample = 0; sample < config.samples; sample++) {
      if (sample) { const remaining = overallMs - (monotonic() - clock); requireValue(remaining > config.intervalMs, 'RUN_BOUND'); await bounded(() => wait(config.intervalMs), remaining, 'RUN_BOUND'); }
      for (const project of config.projects) {
        const target = targetDigest(config, project);
        if (!complete.get(target)) { report.skippedUnknownTargetReads++; continue; }
        try { requireValue(now() < expiresAt, 'HUMAN_SESSION_STALE');
          const value = await request('/v1/projects/' + project.scope.projectId + '/operations', target);
          const observation = assessOperations(value, config, project, now(), revisions.get(target));
          const read = reads.at(-1); read.sample = sample + 1; read.metrics = observation.metrics;
          if (observation.metrics) revisions.set(target, observation.metrics.revision);
          if (!observation.complete) complete.set(target, false);
          observation.findings.forEach(add);
        } catch (error) { complete.set(target, false); failed(target, safeError(error)); }
      }
    }
    for (const [target, done] of complete) if (done) completeTargets.add(target);
    if ([...complete.values()].every(Boolean)) completeTargets.add('RUN');
  } catch (error) { failed('RUN', safeError(error)); completeTargets.clear(); }
  return finish();
  function finish() { report.findings = [...findings.values()]; report.status = statusOf(report.findings); report.completeTargets = [...completeTargets]; report.completedAt = now();
    report.elapsedMs = Math.max(0, Math.round(monotonic() - clock)); report.allAuthorizedReadLatencyMs = { samples: latencies.length, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) };
    const operationsLatencies = reads.filter(read => read.target !== 'SESSION').map(read => read.latencyMs);
    report.operationsReadLatencyMs = { samples: operationsLatencies.length, p50: percentile(operationsLatencies, 0.5), p95: percentile(operationsLatencies, 0.95) };
    report.stopNewWorkRecommended = ['STOP', 'UNKNOWN'].includes(report.status); return report; }
}

/** Open owned private files without following the final symlink, and bound the actual read. */
export async function privateRead(path, maximum) {
  requireValue(isAbsolute(path) && await realpath(path) === resolve(path), 'PRIVATE_FILE_REQUIRED');
  const before = await lstat(path); requireValue(before.isFile() && !before.isSymbolicLink(), 'PRIVATE_FILE_REQUIRED');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const info = await handle.stat(); requireValue(info.isFile() && info.uid === process.getuid() && !(info.mode & 0o077) && info.size <= maximum, 'PRIVATE_FILE_REQUIRED');
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) { const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length); if (!bytesRead) break; length += bytesRead; }
    requireValue(length <= maximum, 'PRIVATE_FILE_BOUND'); return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
export async function accessTransport(config, fetcher = globalThis.fetch) {
  validateConfig(config);
  let token = (await privateRead(config.access.tokenFile, 16384)).toString('utf8').trim();
  requireValue(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token), 'EXISTING_ACCESS_CACHE_REQUIRED');
  // These unsigned claims are only a privacy/expiry prefilter; /api/session and the authority authenticate every read.
  let claims; try { claims = parseJson(Buffer.from(token.split('.')[1], 'base64url')); } catch { throw new MonitorFault('EXISTING_ACCESS_CACHE_REQUIRED'); }
  requireValue(claims.iss === config.access.issuer && (claims.aud === config.access.audience || Array.isArray(claims.aud) && claims.aud.includes(config.access.audience))
    && count(claims.exp) && claims.exp * 1000 > Date.now(), 'EXISTING_ACCESS_CACHE_REQUIRED');
  const allowed = new Set(['/api/session', ...config.projects.map(project => '/v1/projects/' + project.scope.projectId + '/operations')]);
  return { close: () => { token = ''; }, request: async (path, signal) => {
    requireValue(allowed.has(path) && token.length > 0, 'READ_SCOPE_DENIED');
    const response = await fetcher(config.origin + path, { method: 'GET', redirect: 'error', signal,
      headers: { 'CF-Access-Token': token, 'If-Platform-Principal': config.access.principalId,
        ...(path === '/api/session' ? {} : { 'If-Platform-Incarnation': config.projects.find(project => path === '/v1/projects/' + project.scope.projectId + '/operations').scope.projectIncarnation }), Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    const reader = response.body?.getReader(); requireValue(reader, 'RESPONSE_BODY_REQUIRED'); const chunks = []; let length = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; requireValue(length <= LIMITS.responseBytes, 'RESPONSE_BOUND'); chunks.push(chunk.value); } }
    finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    return { status: response.status, bytes: Buffer.concat(chunks) };
  } };
}
async function syncDirectory(path) { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function retain(path, value, maximum = LIMITS.reportBytes) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); requireValue(bytes.length <= maximum, 'LOCAL_REPORT_BOUND');
  const pending = path + '.' + randomUUID() + '.pending', handle = await open(pending, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(pending, path); await syncDirectory(dirname(path));
}
export function correlate(previous, report) {
  requireValue(previous == null || previous.schemaVersion === 1 && previous.configurationDigest === report.configurationDigest && count(previous.sequence)
    && previous.sequence < LIMITS.runs && Array.isArray(previous.alerts) && previous.alerts.length <= LIMITS.findings, 'SPOOL_STATE_INVALID');
  const alerts = new Map((previous?.alerts ?? []).map(row => [row.correlationId, row]));
  for (const row of alerts.values()) requireValue(pin(row.correlationId) && (pin(row.target) || ['RUN', 'SESSION'].includes(row.target))
    && SAFE_CODES.has(row.code) && ['ALERT', 'STOP', 'UNKNOWN'].includes(row.severity) && ['OPEN', 'CLEARED'].includes(row.condition)
    && count(row.occurrences) && row.occurrences < Number.MAX_SAFE_INTEGER && count(row.firstAt) && count(row.lastAt)
    && row.firstAt <= row.lastAt && Object.values(REMEDIATION).includes(row.remediation)
    && keys(row, ['correlationId', 'target', 'code', 'severity', 'firstAt', 'lastAt', 'occurrences', 'condition', 'remediation', ...(row.clearedAt === undefined ? [] : ['clearedAt'])])
    && (row.clearedAt === undefined || count(row.clearedAt)), 'SPOOL_STATE_INVALID');
  for (const [key, row] of alerts) alerts.set(key, { ...row });
  requireValue(alerts.size === (previous?.alerts.length ?? 0), 'SPOOL_STATE_INVALID');
  const observed = new Set();
  for (const finding of report.findings) {
    observed.add(finding.correlationId); const prior = alerts.get(finding.correlationId);
    alerts.set(finding.correlationId, { correlationId: finding.correlationId, target: finding.target, code: finding.code, severity: finding.severity,
      firstAt: prior?.firstAt ?? report.completedAt, lastAt: report.completedAt, occurrences: (prior?.occurrences ?? 0) + 1, condition: 'OPEN',
      remediation: finding.remediation });
  }
  // Partial/unknown reads never clear an older alert. Resolution requires all requested samples for that exact scope.
  for (const row of alerts.values()) if (!observed.has(row.correlationId) && report.completeTargets.includes(row.target)) { row.condition = 'CLEARED'; row.clearedAt = report.completedAt; }
  requireValue(alerts.size <= LIMITS.findings, 'SPOOL_ALERT_BOUND');
  return { schemaVersion: 1, configurationDigest: report.configurationDigest, sequence: (previous?.sequence ?? 0) + 1, lastStatus: report.status, lastObservedAt: report.completedAt, alerts: [...alerts.values()] };
}
export async function retainRun(config, directory, run, { runId = randomUUID(), persist = retain } = {}) {
  validateConfig(config); directory = resolve(directory);
  try { await mkdir(directory, { mode: 0o700 }); await syncDirectory(dirname(directory)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(directory); requireValue(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o077) && await realpath(directory) === directory, 'PRIVATE_SPOOL_REQUIRED');
  requireValue(/^[a-f0-9-]{36}$/.test(runId), 'RUN_ID_INVALID');
  const lockPath = join(directory, '.monitor.lock'); let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch { throw new MonitorFault('SPOOL_LOCK_PRESENT_OR_UNAVAILABLE'); }
  let terminal = false;
  try {
    await lock.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, runId, startedAt: Date.now() }) + '\n'); await lock.sync(); await syncDirectory(directory);
    const entries = await readdir(directory); requireValue(!entries.some(name => name.endsWith('.pending')) && entries.filter(name => /^run-.*\.json$/.test(name)).length < LIMITS.runs, 'SPOOL_REVIEW_REQUIRED');
    const statePath = join(directory, 'alerts.json'); let previous = null;
    try { previous = parseJson(await privateRead(statePath, LIMITS.spoolBytes)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Validate the old spool before network reads; a configuration change needs a separately reviewed spool.
    const retainedRuns = entries.filter(name => /^run-.*\.json$/.test(name));
    requireValue(previous ? retainedRuns.length === previous.sequence : retainedRuns.length === 0, 'SPOOL_REVIEW_REQUIRED');
    correlate(previous, { configurationDigest: configurationDigest(config), findings: [], completeTargets: [], completedAt: Date.now(), status: 'UNKNOWN' });
    const path = join(directory, 'run-' + runId + '.json');
    requireValue(!entries.includes('run-' + runId + '.json'), 'RUN_ID_REUSED');
    await persist(path, { schemaVersion: 1, status: 'STARTED_UNKNOWN', configurationDigest: configurationDigest(config), startedAt: Date.now() });
    const report = await run();
    const state = correlate(previous, report);
    await persist(statePath, state, LIMITS.spoolBytes); await persist(path, report);
    terminal = true; return { report, reportName: 'run-' + runId + '.json', alertCount: state.alerts.filter(row => row.condition === 'OPEN').length };
  } finally {
    await lock.close();
    // An interrupted run or retention failure is deliberately fenced for operator reconciliation.
    if (terminal) { await unlink(lockPath); await syncDirectory(directory); }
  }
}
export async function main(args = process.argv.slice(2)) {
  requireValue(args.length === 5 && args[0] === '--execute-read-only' && args[1] === '--config' && args[3] === '--spool', 'USAGE_REQUIRES_EXPLICIT_READ_ONLY_CONFIG_AND_PRIVATE_SPOOL');
  const config = validateConfig(parseJson(await privateRead(resolve(args[2]), LIMITS.configBytes)));
  const result = await retainRun(config, args[4], async () => { let access;
    try { access = await accessTransport(config); return await monitor(config, access.request); }
    catch (error) { const target = 'SESSION', code = safeError(error); return { schemaVersion: 1, kind: 'BOUNDED_NATIVE_OPERATIONS_MONITOR', status: 'UNKNOWN', configurationDigest: configurationDigest(config), declaredReleaseDigest: config.releaseDigest,
      startedAt: Date.now(), completedAt: Date.now(), completeTargets: [], reads: [], findings: [{ target, code, severity: 'UNKNOWN', remediation: REMEDIATION.access, correlationId: digest(canonical([target, code, ''])) }], unobserved: UNOBSERVED, readiness: 'UNVERIFIED', remoteMutations: 0, modelCalls: 0, automaticRetries: 0, notifications: 0 }; }
    finally { access?.close(); }
  });
  console.log(JSON.stringify({ status: result.report.status, reportName: result.reportName, openAlerts: result.alertCount, readiness: 'UNVERIFIED', notifications: 0 }));
  process.exitCode = exitStatus(result.report.status);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(JSON.stringify({ status: 'UNKNOWN', code: safeError(error), readiness: 'UNVERIFIED' })); process.exitCode = 3;
});
