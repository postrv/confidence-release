// SPDX-License-Identifier: Apache-2.0
import { canonicalize, decodeBase64, digest, parseStrictJson, sha256, verifyAttestation, type AdmissionEvidence, type TrustConfig } from '../../packages/protocol/src/index';
import type { Phase, PreparedRun, SourcePackage, RetainedCallback } from './types';
import { FULL_RELEASE_JOB_COUNT, probes, values } from '../../workers/evaluator/recipes';
import { ownedNames } from './source';
import { OWNED_JOB_COUNT, requests, runScope } from './requests';
import { withinDeadline } from '../../workers/shared/deadline';
export function ensure(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
export async function dispatchOnce<T>(read: () => Phase, write: (phase: Phase) => Promise<void>, effect: () => Promise<T>): Promise<T> {
  ensure(read() === 'NOT_DISPATCHED', 'POSSIBLE_EFFECT_MUST_NOT_REPEAT'); await write('MAY_HAVE_DISPATCHED');
  try { const result = await effect(); await write('ACKNOWLEDGED'); return result; }
  catch (error) { await write('UNKNOWN'); throw error; }
}
export function validatePrepared(prepared: PreparedRun, current: Record<string, string>): void {
  ensure(prepared.schemaVersion === 1 && canonicalize(prepared.names) === canonicalize(ownedNames(prepared.runId)), 'PREPARED_OWNERSHIP');
  ensure(canonicalize(prepared.scope) === canonicalize(runScope(prepared.runId)), 'PREPARED_SCOPE');
  ensure(canonicalize(prepared.sourceDigests) === canonicalize(current), 'SOURCE_CHANGED');
  ensure(prepared.sourceRevision && prepared.sourceDirty === false, 'CLEAN_PINNED_SOURCE_REQUIRED');
}
export function endpointOwned(endpoint: string, name: string): boolean {
  try { const url = new URL(endpoint); return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname === '/' && url.hostname.startsWith(name + '.') && /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname); } catch { return false; }
}
export function managedImageOwned(image: unknown, account: string, evaluatorName: string): image is string {
  if (typeof image !== 'string' || !/^[a-f0-9]{32}$/.test(account) || !/^[a-z0-9-]+$/.test(evaluatorName)) return false;
  // Installed Wrangler buildDurableObjectImageTag uses script-class-image.
  return new RegExp(`^registry\\.cloudflare\\.com/${account}/${evaluatorName}-conformanceevaluation-base@sha256:[a-f0-9]{64}$`).test(image);
}
/** Exact config bindings; an additional unreviewed capability fails closed. */
function configuredBindingNames(config: any): string[] {
  return [...Object.keys(config.vars), ...config.secrets.required, ...config.r2_buckets.map((value: any) => value.binding), ...config.services.map((value: any) => value.binding), ...config.durable_objects.bindings.map((value: any) => value.name)];
}
export function deploymentAssociations(input: { prepared: PreparedRun; account: string; image: string; configs: Record<string, any>; evaluator: any; controller: any; application: any }) {
  const { prepared, configs, evaluator, controller, application } = input, names = prepared.names;
  ensure(managedImageOwned(input.image, input.account, names.evaluator), 'EXACT_MANAGED_IMAGE_UNOBSERVED');
  const local: Record<string, { namespaceId: string; className: string }> = {};
  for (const role of ['evaluator', 'controller'] as const) {
    const config = configs[role], settings = role === 'evaluator' ? evaluator : controller;
    ensure(config?.name === names[role] && config.account_id === input.account && settings?.compatibility_date === config.compatibility_date && canonicalize([...(settings.compatibility_flags ?? [])].sort()) === canonicalize([...(config.compatibility_flags ?? [])].sort()), 'DEPLOYED_COMPATIBILITY_MISMATCH');
    const bindings = settings.bindings, expectedNames = configuredBindingNames(config);
    ensure(Array.isArray(bindings) && bindings.length === expectedNames.length && new Set(expectedNames).size === expectedNames.length && new Set(bindings.map((value: any) => value?.name)).size === bindings.length && bindings.every((value: any) => expectedNames.includes(value?.name)), 'DEPLOYED_BINDING_SET_MISMATCH');
    const binding = (name: string, type: string) => { const value = bindings.find((item: any) => item.name === name); ensure(value?.type === type, 'DEPLOYED_BINDING_TYPE_MISMATCH'); return value; };
    for (const [name, text] of Object.entries(config.vars)) ensure(binding(name, 'plain_text').text === String(text), 'DEPLOYED_PLAIN_VAR_MISMATCH');
    for (const name of config.secrets.required) binding(name, 'secret_text');
    for (const value of config.r2_buckets) { const actual = binding(value.binding, 'r2_bucket'); ensure(actual.bucket_name === names.bucket && (!actual.jurisdiction || actual.jurisdiction === 'default'), 'DEPLOYED_R2_MISMATCH'); }
    for (const value of config.services) { const actual = binding(value.binding, 'service'); ensure(actual.service === value.service && value.service === names[role === 'evaluator' ? 'controller' : 'evaluator'] && (!actual.environment || actual.environment === 'production') && !actual.entrypoint && !actual.entry_point, 'DEPLOYED_SERVICE_MISMATCH'); }
    for (const value of config.durable_objects.bindings) {
      const actual = binding(value.name, 'durable_object_namespace');
      ensure(actual.class_name === value.class_name && /^[a-f0-9]{32}$/.test(actual.namespace_id) && (!actual.script_name || actual.script_name === (value.script_name ?? names[role])) && !actual.environment, 'DEPLOYED_NAMESPACE_MISMATCH');
      if (!value.script_name) local[value.name] = { namespaceId: actual.namespace_id, className: actual.class_name };
    }
  }
  ensure(Object.keys(local).sort().join(',') === 'CONTROL,EVALUATIONS,FIXTURES,SCHEDULER' && new Set(Object.values(local).map(value => value.namespaceId)).size === 4, 'DEPLOYED_LOCAL_NAMESPACES_MISMATCH');
  for (const name of ['EVALUATIONS', 'SCHEDULER', 'FIXTURES']) { const actual = controller.bindings.find((value: any) => value.name === name); ensure(actual.namespace_id === local[name].namespaceId && actual.class_name === local[name].className, 'DEPLOYED_CROSS_WORKER_NAMESPACE_MISMATCH'); }
  ensure(application?.name === names.container && /^[a-f0-9]{32}$/.test(application.id) && application.scheduling_policy === 'durable_object' && application.durable_objects?.namespace_id === local.EVALUATIONS.namespaceId, 'APPLICATION_NAMESPACE_ASSOCIATION_MISMATCH');
  return { applicationId: application.id, namespaceId: local.EVALUATIONS.namespaceId, className: 'ConformanceEvaluation', namespaces: local };
}
type AssociationInput = Parameters<typeof deploymentAssociations>[0];
type AssociationReadback = Pick<AssociationInput, 'evaluator' | 'controller' | 'application'> & { observed: boolean };
const associationCodes = new Set(['DEPLOYMENT_ASSOCIATION_UNOBSERVED', 'DEPLOYMENT_ASSOCIATION_READ_DEADLINE', 'EXACT_MANAGED_IMAGE_UNOBSERVED', 'DEPLOYED_COMPATIBILITY_MISMATCH', 'DEPLOYED_BINDING_SET_MISMATCH', 'DEPLOYED_BINDING_TYPE_MISMATCH', 'DEPLOYED_PLAIN_VAR_MISMATCH', 'DEPLOYED_R2_MISMATCH', 'DEPLOYED_SERVICE_MISMATCH', 'DEPLOYED_NAMESPACE_MISMATCH', 'DEPLOYED_LOCAL_NAMESPACES_MISMATCH', 'DEPLOYED_CROSS_WORKER_NAMESPACE_MISMATCH', 'APPLICATION_NAMESPACE_ASSOCIATION_MISMATCH']);
function bindingSummary(config: any, settings: any) {
  const expectedNames = configuredBindingNames(config).sort();
  const bindings: any[] | null = Array.isArray(settings?.bindings) ? settings.bindings : null;
  const label = (value: unknown) => typeof value === 'string' && /^[A-Za-z_$][A-Za-z0-9_$-]{0,127}$/.test(value) ? value : 'INVALID';
  const actualBindings = bindings?.slice(0, 64).map(value => ({ name: label(value?.name), type: label(value?.type) })).sort((left, right) => left.name.localeCompare(right.name)) ?? [];
  const names = actualBindings.map(value => value.name);
  return { expectedNames, observedCount: bindings?.length ?? null, actualBindings, truncated: (bindings?.length ?? 0) > 64,
    missing: expectedNames.filter(name => !names.includes(name)), extra: [...new Set(names.filter(name => !expectedNames.includes(name)))], duplicates: [...new Set(names.filter((name, index) => names.indexOf(name) !== index))] };
}
export interface AssociationAttempt {
  attempt: number; observedAt: string; elapsedMs: number; status: 'PASS' | 'RETRY'; reason: string | null;
  bindings: { evaluator: ReturnType<typeof bindingSummary>; controller: ReturnType<typeof bindingSummary> };
}
/** Read-only propagation convergence. Every attempt must pass the complete strict gate. */
export async function awaitDeploymentAssociations(input: {
  expected: Omit<AssociationInput, 'evaluator' | 'controller' | 'application'>;
  read(signal: AbortSignal): Promise<AssociationReadback>;
  retain(attempt: AssociationAttempt): Promise<void>;
  bounds?: { timeoutMs: number; intervalMs: number; maximumAttempts: number };
}) {
  const bounds = input.bounds ?? { timeoutMs: 45000, intervalMs: 2000, maximumAttempts: 12 };
  ensure(Number.isSafeInteger(bounds.timeoutMs) && bounds.timeoutMs > 0 && bounds.timeoutMs <= 45000
    && Number.isSafeInteger(bounds.intervalMs) && bounds.intervalMs >= 0 && bounds.intervalMs <= 2000
    && Number.isSafeInteger(bounds.maximumAttempts) && bounds.maximumAttempts > 0 && bounds.maximumAttempts <= 12, 'INVALID_ASSOCIATION_POLL_BOUNDS');
  const started = Date.now(), deadline = started + bounds.timeoutMs;
  for (let attempt = 1; attempt <= bounds.maximumAttempts && Date.now() < deadline; attempt++) {
    let readback: AssociationReadback | undefined, association: ReturnType<typeof deploymentAssociations> | undefined, reason: string | null = null;
    const abort = new AbortController();
    try {
      readback = await withinDeadline(() => input.read(abort.signal), deadline - Date.now(), 'DEPLOYMENT_ASSOCIATION_READ_DEADLINE');
      ensure(Date.now() < deadline, 'DEPLOYMENT_ASSOCIATION_READ_DEADLINE');
      ensure(readback.observed, 'DEPLOYMENT_ASSOCIATION_UNOBSERVED');
      association = deploymentAssociations({ ...input.expected, evaluator: readback.evaluator, controller: readback.controller, application: readback.application });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      reason = associationCodes.has(code) ? code : 'DEPLOYMENT_ASSOCIATION_READ_FAILED';
    } finally { abort.abort(); }
    await input.retain({ attempt, observedAt: new Date().toISOString(), elapsedMs: Date.now() - started, status: association ? 'PASS' : 'RETRY', reason,
      bindings: { evaluator: bindingSummary(input.expected.configs.evaluator, readback?.evaluator), controller: bindingSummary(input.expected.configs.controller, readback?.controller) } });
    if (association) return association;
    if (attempt < bounds.maximumAttempts && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(bounds.intervalMs, deadline - Date.now())));
  }
  throw new Error('DEPLOYMENT_ASSOCIATION_NOT_CONVERGED');
}
/** Only the provider's observed leading ./ alias is normalized. */
function logicalModuleName(name: string): string | null {
  const logical = name.startsWith('./') ? name.slice(2) : name;
  if (!logical || logical.startsWith('/') || logical.includes('\\') || /^[A-Za-z]:/.test(logical) || logical.split('/').some(segment => !segment || segment === '.' || segment === '..')) return null;
  return logical;
}
/** Every module, including WASM, is compared to the locally retained package. */
export async function deployedModulesMatch(response: Response, expected: Record<string, Uint8Array>): Promise<boolean> {
  if (response.status !== 200 || !response.body || !response.headers.get('content-type')?.startsWith('multipart/')) return false;
  const bytes = await boundedBytes(response, 2 * 1024 * 1024), form = await new Response(bytes.slice().buffer, { headers: response.headers }).formData();
  const modules = new Map<string, FormDataEntryValue>(), expectedModules = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(expected)) { const logical = logicalModuleName(name); if (!logical || expectedModules.has(logical)) return false; expectedModules.set(logical, bytes); }
  for (const [name, part] of form.entries()) { const logical = logicalModuleName(name); if (!logical || modules.has(logical)) return false; modules.set(logical, part); }
  if ([...expectedModules.keys()].some(name => !modules.has(name)) || [...modules.keys()].some(name => !name.endsWith('.map') && !expectedModules.has(name))) return false;
  for (const [name, bytes] of expectedModules) { const part = modules.get(name); if (!(part instanceof File) || await sha256(new Uint8Array(await part.arrayBuffer())) !== await sha256(bytes)) return false; }
  const entrypoint = response.headers.get('cf-entrypoint'), logical = entrypoint === null ? null : logicalModuleName(entrypoint);
  return logical !== null && expectedModules.has(logical);
}
export async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  ensure(response.body, 'RESPONSE_BODY_REQUIRED'); const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; ensure(size <= maximum, 'RESPONSE_SIZE_LIMIT'); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
}
export async function jsonResponse(response: Response, maximum = 512 * 1024): Promise<any> { return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(response, maximum))); }
export async function evaluateProof(input: { prepared: PreparedRun; image: string; checkerDigest: string; trust: TrustConfig; snapshot: any; callbacks: RetainedCallback[]; sources: { good: SourcePackage; bad: SourcePackage } }) {
  const expected = await requests(input.sources, { runId: input.prepared.runId, imageDigest: input.image.split('@')[1], checkerDigest: input.checkerDigest, checkerKeyId: 'owned-checker' });
  const goodSourceDigest = await digest(input.sources.good), badSourceDigest = await digest(input.sources.bad);
  const state = input.snapshot; ensure(state.runId === input.prepared.runId && canonicalize(state.scope) === canonicalize(input.prepared.scope) && canonicalize(state.trust) === canonicalize(input.trust), 'RUN_OR_TRUST_MISMATCH');
  ensure(state.sources?.good === goodSourceDigest && state.sources?.bad === badSourceDigest, 'SOURCE_PACKAGE_MISMATCH');
  ensure(Array.isArray(state.jobs) && state.jobs.length === OWNED_JOB_COUNT && Object.keys(state.scheduler).length === OWNED_JOB_COUNT && input.callbacks.length === OWNED_JOB_COUNT, 'INCOMPLETE_PLAN');
  const good: string[] = [], bad: string[] = [], observations = [];
  for (const task of expected) {
    const row = state.jobs.find((row: any) => row.native.jobKey === task.jobKey), callback = input.callbacks.find(callback => callback.evidence.jobId === task.request.job.id);
    ensure(row && callback && row.category === task.category && row.dispatch === 'ACKNOWLEDGED' && row.requestDigest === task.requestDigest && row.native.requestDigest === task.requestDigest && row.native.jobId === task.request.job.id, 'JOB_IDENTITY_MISMATCH');
    ensure(row.native.configuredImage === input.image && row.native.phase === 'STOPPED' && row.native.container === null && row.native.terminationObserved === true && row.native.callbackDelivered === true && state.scheduler[task.jobKey]?.status === 'DONE', 'NATIVE_STOP_OR_CAPACITY_UNOBSERVED');
    ensure(row.fixture?.closed === true && (row.fixture.state?.active === false || (task.category === 'restart-fault' && row.fixture.state === null)), 'FIXTURE_FENCE_UNOBSERVED');
    ensure(row.native.callbackDigest === await digest(callback) && row.callback.digest === await digest(callback), 'CALLBACK_CHANGED');
    const proof = verifyAttestation<AdmissionEvidence>({ trust: input.trust, envelope: callback.envelope, kind: 'evidence', role: 'checker', authorityRevision: '1', allowLegacy: false });
    ensure(proof.valid && canonicalize(proof.record) === canonicalize(callback.evidence) && canonicalize(proof.issuance) === canonicalize(task.request.issuance), 'SIGNED_EVIDENCE_INVALID');
    const evidence = callback.evidence, bytes = decodeBase64(callback.observationBase64), { digest: claimed, ...identity } = evidence;
    ensure(await digest(identity) === claimed && evidence.candidateId === task.request.candidate.id && evidence.candidateDigest === task.request.candidate.digest && evidence.inputDigest === task.request.job.inputDigest && await sha256(bytes) === evidence.observationDigest, 'EVIDENCE_BINDING_MISMATCH');
    const observation = parseStrictJson(new TextDecoder().decode(bytes)) as any; ensure(observation.jobId === evidence.jobId && observation.inputDigest === evidence.inputDigest && observation.outcome === evidence.outcome && canonicalize(observation.scope) === canonicalize(task.request.scope) && canonicalize(observation.evaluation) === canonicalize(task.request.evaluation) && observation.terminationObserved === true, 'OBSERVATION_BINDING_MISMATCH');
    if (task.request.job.id.endsWith(':overlapping-read-write')) {
      const expectedValues = values(probes.find(probe => probe.id === 'overlapping-read-write')!);
      const trace = observation.observations.filter((entry: any) => entry.action);
      ensure(trace.length === 5 && trace.map((entry: any) => entry.action).join(',') === 'overlap-captured,write,overlap-released,overlap-read,read', 'OVERLAP_ORDER_UNOBSERVED');
      ensure(trace[0].observed === expectedValues.initial && trace[0].storeReadCount === 1 && trace[1].observed === expectedValues.replacement
        && trace[1].status >= 200 && trace[1].status < 300 && trace[2].afterWriteStatus === trace[1].status
        && [expectedValues.initial, expectedValues.replacement].includes(trace[3].observed) && trace[3].status >= 200 && trace[3].status < 300
        && trace[4].status >= 200 && trace[4].status < 300, 'OVERLAP_CAPTURE_OR_WRITE_UNOBSERVED');
      ensure(observation.backingStore?.active === false && observation.backingStore.value === expectedValues.replacement
        && observation.backingStore.readBarrier?.phase === 'FENCED' && observation.backingStore.readBarrier.capturedValue === expectedValues.initial
        && canonicalize(observation.backingStore) === canonicalize(row.fixture.state), 'OVERLAP_FENCE_UNOBSERVED');
      const accesses = observation.backingStore.accesses;
      ensure(Array.isArray(accesses) && accesses.length >= 2 && accesses.length <= 128
        && accesses[0].method === 'GET' && accesses[0].value === expectedValues.initial
        && accesses[1].method === 'PUT' && accesses[1].value === expectedValues.replacement
        && accesses.slice(2).every((access: any) => access.method === 'GET' && access.value === expectedValues.replacement)
        && observation.backingStore.reads === accesses.length - 1, 'OVERLAP_STORE_TRACE_UNOBSERVED');
      ensure(task.category === 'good' ? trace[4].observed === expectedValues.replacement : evidence.outcome === 'FAIL' && trace[4].observed === expectedValues.initial, 'OVERLAP_EXTERNAL_ORACLE_FAILED');
    }
    if (task.category === 'good') { ensure(evidence.outcome === 'PASS', 'GOOD_REQUIRED_JOB_NOT_PASS'); good.push(evidence.digest); }
    if (task.category === 'bad') { ensure(['PASS', 'FAIL'].includes(evidence.outcome), 'BAD_CANDIDATE_CHECK_INCOMPLETE'); bad.push(evidence.outcome); }
    if (task.category === 'callback-fault') {
      ensure(evidence.outcome === 'PASS' && row.callback.rejectedOnce === true && row.callback.deliveries >= 2, 'CALLBACK_RETRY_UNOBSERVED');
      const witness = row.callback.rejectionWitness, native = witness?.native, slot = witness?.scheduler;
      const started = Date.parse(witness?.captureStartedAt ?? ''), captured = Date.parse(witness?.capturedAt ?? ''), nativeObserved = Date.parse(native?.observedAt ?? '');
      const code = 'CALLBACK_HELD_SLOT_WITNESS_UNOBSERVED';
      ensure(witness?.schemaVersion === 1 && witness.runId === input.prepared.runId && witness.jobKey === task.jobKey && witness.jobId === task.request.job.id && witness.requestDigest === task.requestDigest && witness.sourceDigest === goodSourceDigest, code);
      ensure(witness.candidateDigest === task.request.candidate.digest && witness.inputDigest === task.request.job.inputDigest && witness.callbackDigest === await digest(callback) && witness.evidenceDigest === evidence.digest && witness.observationDigest === evidence.observationDigest, code);
      ensure(witness.responseStatus === 503 && witness.deliveryNumber === 1 && Number.isSafeInteger(started) && Number.isSafeInteger(captured) && captured >= started && captured - started <= 1500, code);
      ensure(Number.isSafeInteger(nativeObserved) && nativeObserved >= started - 5000 && nativeObserved <= captured + 5000, code);
      ensure(native?.jobKey === task.jobKey && native.jobId === task.request.job.id && native.requestDigest === task.requestDigest && native.configuredImage === input.image && native.phase === 'STOPPED' && native.container === null, code);
      ensure(native.terminationObserved === true && native.callbackDelivered === false && native.callbackDigest === witness.callbackDigest && native.deadline === row.native.deadline, code);
      ensure(slot?.status === 'ACTIVE' && slot.digest === task.requestDigest && slot.object === task.requestDigest && Number.isSafeInteger(slot.priority), code);
    }
    if (task.category === 'restart-fault') {
      const request = row.native.abortRequest, uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
      ensure(row.native.abortIntent === true && evidence.outcome === 'INCONCLUSIVE' && observation.error === 'Evaluator continuation was lost; its generation is fenced and termination is observed separately.' && uuid.test(row.native.controllerInstanceId) && uuid.test(request?.controllerInstanceId) && row.native.controllerInstanceId !== request.controllerInstanceId && request.jobId === task.request.job.id && request.jobKey === task.jobKey && request.requestDigest === task.requestDigest && request.phase === 'RUNNING' && Number.isSafeInteger(request.observedAt) && request.observedAt < request.deadline && request.deadline === row.native.deadline, 'RESTART_RECONCILIATION_UNOBSERVED');
    }
    observations.push({ jobId: evidence.jobId, category: task.category, outcome: evidence.outcome, evidenceDigest: evidence.digest, observationDigest: evidence.observationDigest, requestDigest: task.requestDigest });
  }
  ensure(good.length === FULL_RELEASE_JOB_COUNT && bad.length === FULL_RELEASE_JOB_COUNT && bad.includes('FAIL'), 'EXTERNAL_ORACLE_DID_NOT_REJECT_BAD');
  return { status: 'PASS', goodRequiredJobs: FULL_RELEASE_JOB_COUNT, badRequiredJobs: FULL_RELEASE_JOB_COUNT, badFailures: bad.filter(outcome => outcome === 'FAIL').length, faultJobs: 2, stoppedGenerations: OWNED_JOB_COUNT, heldSlotWitnesses: 1, observations };
}
