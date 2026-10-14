// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonicalize, digest, encodeBase64, issuedStatement, signStatement, verifyBundle } from '../packages/protocol/src/index.ts';
import type { AdmissionCandidate, EvaluationPlan, GitObject, IssuanceContext, Scope } from '../packages/protocol/src/types.ts';
import type { WeftBinding, WeftSelection } from '../packages/protocol/src/weft.ts';
import { authorityRuntime } from './test-weft/authority-runtime.ts';
import { weftRuntime, WEFT_REVISION } from './test-weft/weft-runtime.ts';
import { measureLocalCandidate } from './test-weft/local-probes.ts';
import { OWNED_REPOSITORY } from './test-weft/owned-git.ts';
import { probes, values } from '../workers/evaluator/recipes.ts';
import type { Probe as LocalProbe } from '../services/probes.ts';

interface Dispatch { scope: Scope; candidate: AdmissionCandidate; evaluation: { id: string }; issuance: IssuanceContext; checkerKeyId: string; plan: EvaluationPlan; job: EvaluationPlan['jobs'][number] }
type Runtime = Awaited<ReturnType<typeof authorityRuntime>>;

async function sourceProvenance() {
  const included = ['workers', 'packages', 'services', 'fixtures/collaboration-demo', 'infra/test-weft', 'infra/weft-runtime-check.ts', 'tests/conformance/vector.ts',
    'scripts/weft-access*.mjs', 'crates/protocol', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'package.json', 'package-lock.json', 'tsconfig.json'];
  const names = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...included], { cwd: resolve('.'), maxBuffer: 2 * 1024 * 1024 }).toString().split('\0').filter(Boolean))].sort();
  assert.ok(names.length > 0 && names.length < 10000);
  let total = 0; const files = [];
  for (const path of names) {
    const bytes = await readFile(resolve(path)); total += bytes.length; assert.ok(total <= 64 * 1024 * 1024);
    files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve('.') }).toString().trim(),
    dirty: execFileSync('git', ['status', '--porcelain', '-z'], { cwd: resolve('.'), maxBuffer: 2 * 1024 * 1024 }).length > 0,
    treeDigest: await digest(files), closure: 'headless-rehearsal-source-and-build-inputs', files };
}

function dispatch(value: unknown): Dispatch {
  assert.ok(value && typeof value === 'object' && 'candidate' in value && 'job' in value && 'plan' in value && 'issuance' in value && 'scope' in value);
  const request = value as Dispatch;
  assert.equal(request.scope.schemaVersion, 1); assert.equal(request.issuance.schemaVersion, 1);
  assert.equal(request.candidate.id, request.plan.candidateId); assert.equal(request.candidate.digest, request.plan.candidateDigest);
  assert.ok(request.plan.jobs.some(job => job.id === request.job.id && job.inputDigest === request.job.inputDigest));
  return request;
}

async function measureAndReport(runtime: Runtime, candidate: AdmissionCandidate) {
  const objects = await runtime.control('objects', { candidateId: candidate.id }) as GitObject[];
  for (const object of objects) {
    const written = (await runtime.git.git.git(['hash-object', '-w', '-t', object.type, '--stdin'], { input: Buffer.from(object.dataBase64, 'base64') })).toString().trim();
    assert.equal(written, object.oid);
  }
  const local = await measureLocalCandidate(runtime.git.git, candidate, runtime.git.directory);
  const requests = runtime.evaluationRequests.splice(0).map(dispatch);
  const selected = requests.filter(request => request.candidate.id === candidate.id);
  assert.equal(selected.length, 9);
  const callbacks = [];
  for (const request of selected) {
    const registeredProbe = probes.find(probe => request.job.id === `${request.evaluation.id}:${probe.id}`); assert.ok(registeredProbe);
    const localJob = local.plan.jobs.find(job => (job.input.fixture as LocalProbe).seed === registeredProbe.seed); assert.ok(localJob);
    const localProbe = localJob.input.fixture as LocalProbe;
    assert.deepEqual(localProbe.actions, registeredProbe.actions); assert.equal(localProbe.assertion, registeredProbe.assertion);
    assert.deepEqual(localProbe.values, values(registeredProbe));
    const measured = local.observations.find(observation => observation.jobId === localJob.id); assert.ok(measured);
    const observation = { testOnly: true, environment: 'real-local-sibling-process-checker', containerIsolationQualified: false,
      registeredJobId: request.job.id, registeredProbeId: registeredProbe.id, measuredLocalJobId: measured.jobId,
      protocolRehearsalOnly: 'Synthetic checker trust tests authority behavior; local execution does not satisfy the production container/environment declaration', measurement: measured };
    const unsigned = { id: `owned-${request.job.id}`, jobId: request.job.id, inputDigest: request.job.inputDigest,
      observationDigest: await digest(observation), candidateId: candidate.id, candidateDigest: candidate.digest,
      outcome: measured.outcome, evidenceClass: 'protected-behavioural' as const, authorized: true as const };
    const evidence = { ...unsigned, digest: await digest(unsigned) };
    const callback = { scope: request.scope, evidence,
      envelope: await signStatement(await issuedStatement('evidence', evidence, request.issuance), request.checkerKeyId, runtime.checkerKey.privateKey),
      observationBase64: encodeBase64(new TextEncoder().encode(canonicalize(observation))) };
    await runtime.control('evidence', callback); callbacks.push(callback);
  }
  return { local, callbacks };
}

export async function runWeftJourney() {
  const source = await sourceProvenance();
  let weft: Awaited<ReturnType<typeof weftRuntime>> | undefined;
  let fault: 'tamper' | 'incomplete' | 'backpressure' | null = null;
  let contentRequests = 0;
  const replicaAudience = '3'.repeat(64);
  const runtime = await authorityRuntime({ replicaAudience, weft: async request => {
    assert.ok(weft);
    if (request.url.endsWith('/sync-contents')) {
      contentRequests++;
      if (fault === 'backpressure') { fault = null; return Response.json({ error: 'PROJECT_BACKPRESSURE', message: 'Owned one-shot retry fixture' }, { status: 429 }); }
    }
    const response = await weft.fetch(request.url, request);
    if (!fault || !request.url.endsWith('/sync-contents') || !response.ok) return new Response(await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) });
    const value = await response.json() as { objects: Record<string, string> };
    const first = Object.keys(value.objects)[0]; assert.ok(first);
    if (fault === 'tamper') value.objects[first] += '\nowned tamper'; else delete value.objects[first];
    return Response.json(value);
  } });
  const checks: string[] = [];
  try {
    const enrollment = await runtime.enroll();
    const initial = Object.fromEntries(Object.entries(await runtime.git.git.files(runtime.git.base)).map(([path, bytes]) => [path, { text: bytes.toString('utf8'), mode: 0o100644 }]));
    const sourceBase = { repo: OWNED_REPOSITORY, repositoryId: 'owned-artifacts-repository', branch: 'main', oid: runtime.git.base };
    weft = await weftRuntime(initial, { sourceBase, revision: process.env.WEFT_TEST_REVISION || WEFT_REVISION, gitSeed: { repository: runtime.git.canonical, commit: runtime.git.base } });
    const binding: WeftBinding = { id: 'owned-weft-binding', scope: enrollment.scope, workspaceId: weft.workspace, alternativeId: null,
      sourceRepo: sourceBase.repo, sourceRepositoryId: sourceBase.repositoryId, sourceRef: 'refs/heads/main', sourceBase: sourceBase.oid, weftSourceRevision: weft.sourceRevision };
    await runtime.connect([binding]);
    await runtime.command('set-membership', { subject: runtime.issuer + '#peer', roles: ['reader', 'sponsor'], active: true });
    await runtime.command('set-membership', { subject: runtime.issuer + '#reader', roles: ['reader'], active: true });
    const replicaToken = (subject: string, aud: string | string[] = replicaAudience) =>
      runtime.token(subject, { aud, principal_class: undefined, type: 'app', email: subject + '@owned.test' });
    const accessTokens = { primary: await replicaToken('owner'), peer: await replicaToken('peer') };
    async function replicaRequest(path: string, init: RequestInit = {}, subject = 'owner', expected = 200) {
      const response = await runtime.fetch(path, { ...init, headers: { ...init.headers, 'cf-access-jwt-assertion': await replicaToken(subject) } });
      const text = await response.text(); assert.equal(response.status, expected, `${path}: ${text}`); return JSON.parse(text);
    }
    const replicaDeniedOperations: string[] = [];
    async function rejectReplicaCommand(operation: string, body: Record<string, unknown>) {
      const current = await runtime.snapshot();
      const result = await replicaRequest(`/v1/projects/${runtime.projectId}/${operation}`, { method: 'POST',
        headers: { origin: runtime.origin, 'x-platform-csrf': '1', 'content-type': 'application/json',
          'idempotency-key': 'owned-replica-denied-' + operation, 'if-platform-revision': current.project.revision,
          'if-platform-incarnation': enrollment.scope.projectIncarnation }, body: JSON.stringify(body),
      }, 'owner', 401);
      assert.equal(result.error.code, 'AUTHENTICATION_FAILED');
      assert.equal((await runtime.snapshot()).project.revision, current.project.revision);
      replicaDeniedOperations.push(operation);
    }
    const transport: typeof fetch = async (input, init) => {
      const incoming = new Request(input, init), path = new URL(incoming.url).pathname;
      assert.ok(path.startsWith(`/api/projects/${runtime.projectId}/weft/api/workspaces/` + weft!.workspace + '/'));
      assert.equal(incoming.headers.get('origin'), runtime.origin);
      assert.equal(incoming.headers.get('x-platform-csrf'), '1');
      assert.equal(incoming.headers.get('authorization'), null);
      assert.equal(incoming.headers.get('cf-access-jwt-assertion'), null);
      const accessToken = incoming.headers.get('cf-access-token'); assert.ok(accessToken && Object.values(accessTokens).includes(accessToken));
      // Test-only Access ingress simulation. Production authenticate still
      // verifies the actual signed JWT and derives identity from issuer/subject.
      const headers = new Headers(incoming.headers); headers.delete('cf-access-token'); headers.set('cf-access-jwt-assertion', accessToken);
      const response = await runtime.fetch(path, { method: incoming.method, headers, ...(incoming.method === 'POST' ? { body: await incoming.text() } : {}) });
      return new Response(await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) });
    };
    const { createConfidenceAccessFetch } = await import(pathToFileURL(resolve('scripts/weft-access.mjs')).href);
    await weft.useConfidence(createConfidenceAccessFetch({ origin: runtime.origin, projectId: runtime.projectId }, transport), accessTokens,
      `${runtime.origin}/api/projects/${runtime.projectId}/weft`);
    const viewPath = `/api/projects/${runtime.projectId}/weft`;
    const proxyPath = `${viewPath}/api/workspaces/${weft.workspace}/sync`;
    const bareBearer = await runtime.fetch(proxyPath, { headers: { authorization: 'Bearer ' + accessTokens.primary } });
    assert.equal(bareBearer.status, 401); assert.equal((await bareBearer.json() as { error: string }).error, 'CREDENTIAL_CLASS_REQUIRED');
    const mainProxy = await runtime.fetch(proxyPath, { headers: { 'cf-access-jwt-assertion': await replicaToken('owner', runtime.audience) } });
    assert.equal(mainProxy.status, 401); assert.equal((await mainProxy.json() as { error: string }).error, 'AUTHENTICATION_FAILED');
    const mainAlias = await runtime.request(`/api/weft/api/workspaces/${weft.workspace}/sync`, {}, 'owner', 404);
    assert.equal(mainAlias.error, 'UNSUPPORTED_ROUTE');
    for (const path of [viewPath, '/api/session', `/v1/projects/${runtime.projectId}/state`,
      `/api/projects/${runtime.projectId}/collaboration`, viewPath + '/handoffs/owned-not-created',
      `/api/weft/api/workspaces/${weft.workspace}/sync`]) {
      const denied = await replicaRequest(path, {}, 'owner', 401);
      assert.equal(path.includes('/weft/api/workspaces/') ? denied.error : denied.error.code, 'AUTHENTICATION_FAILED');
    }
    for (const path of [viewPath, proxyPath]) {
      const mixed = await runtime.fetch(path, { headers: { 'cf-access-jwt-assertion': await replicaToken('owner', [runtime.audience, replicaAudience]) } });
      assert.equal(mixed.status, 401);
      const denied = await mixed.json() as { error: string | { code: string } };
      assert.equal(path === proxyPath ? denied.error : (denied.error as { code: string }).code, 'AUTH_AUDIENCE_ISOLATION');
    }
    await rejectReplicaCommand('set-membership', { subject: runtime.issuer + '#replica-escalation', roles: ['reader', 'admin', 'reviewer'], active: true });
    const before = await runtime.request(viewPath); assert.equal(before.head.revision, 0); assert.equal(before.binding.id, binding.id);
    for (const secret of [weft.token, runtime.git.token, await runtime.token()]) assert.ok(!JSON.stringify(before).includes(secret));
    for (const route of ['source', 'source-access', 'publication']) {
      const denied = await weft.fetch(`https://weft.owned.test/api/workspaces/${weft.workspace}/${route}`, {
        method: 'POST', headers: { authorization: 'Bearer ' + weft.token, 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(denied.status, 403); assert.equal((await denied.json() as { error: string }).error, 'EXTERNAL_RELEASE_AUTHORITY');
    }
    await runtime.request(viewPath, {}, 'guest', 404);
    await replicaRequest(`${viewPath}/api/workspaces/unbound-workspace/sync`, {}, 'owner', 403);
    await replicaRequest(`${viewPath}/api/workspaces/${weft.workspace}/prepare`, { method: 'POST', headers: { origin: runtime.origin, 'x-platform-csrf': '1', 'content-type': 'application/json' }, body: '{}' }, 'reader', 403);
    assert.equal((await weft.fetch(`https://weft.owned.test/api/workspaces/${weft.workspace}/sync`, { headers: { authorization: 'Bearer ' + await runtime.token('peer') } })).status, 401);
    checks.push('Authorized project/workspace link; unadmitted synthetic principal denied');
    const [first, second] = await Promise.all([
      weft.session('owned-deterministic-session-one', { kind: 'replace', path: 'cache.mjs', oldText: 'cacheTtlMs = 0', newText: 'cacheTtlMs = 60000' }),
      weft.session('owned-deterministic-session-two', { kind: 'replace', path: 'presentation.mjs', oldText: '<p>${value}</p>', newText: '<p role="status" aria-live="polite" aria-label="Saved value">Saved value: ${value}</p>' }),
    ]);
    assert.equal(first.state, 'accepted'); assert.equal(second.state, 'accepted');
    const sharedRevision = Math.max(first.acceptedRevision, second.acceptedRevision);
    const peer = await weft.syncPeer(); assert.equal(peer.appliedRevision, sharedRevision);
    assert.match(await readFile(join(weft.peer, 'cache.mjs'), 'utf8'), /cacheTtlMs = 60000/);
    assert.match(await readFile(join(weft.peer, 'presentation.mjs'), 'utf8'), /aria-label="Saved value"/);
    const selected = await replicaRequest(`${viewPath}/api/workspaces/${weft.workspace}/sync/revisions/${sharedRevision}`);
    const selection: WeftSelection = { schemaVersion: 1, bindingId: binding.id, revision: selected.revision, root: selected.manifest.root,
      privacyGeneration: selected.privacyGeneration, expectedBase: runtime.git.base, context: { note: 'Owned deterministic two-session collaboration rehearsal' } };
    const view = await runtime.request(viewPath); assert.equal(view.head.root, selected.manifest.root);
    assert.equal(view.participants, null); assert.equal(view.replicas, null);
    checks.push('Two independent processes through one physical-worktree daemon; actual peer applied revision and disk bytes observed');

    await rejectReplicaCommand('submit-weft-revision', { ...selection });
    await runtime.command('submit-weft-revision', { ...selection, bindingId: 'wrong-project-binding' }, { expected: 409 });
    await runtime.command('submit-weft-revision', { ...selection, submittedBy: runtime.issuer + '#peer' }, { expected: 409 });
    for (const injected of ['tamper', 'incomplete'] as const) {
      fault = injected;
      const id = `owned-${injected}`, admission = await runtime.command('submit-weft-revision', { ...selection }, { id });
      await runtime.control('drain');
      const result = await runtime.request(viewPath + '/handoffs/' + id);
      assert.equal(result.state, 'REJECTED'); assert.ok(result.reason); assert.equal((await runtime.snapshot()).candidates.length, 0);
      assert.ok(admission.candidateId); fault = null;
    }
    const missingId = 'owned-missing-selection';
    await runtime.command('submit-weft-revision', { ...selection, revision: 999999 }, { id: missingId }); await runtime.control('drain');
    assert.equal((await runtime.request(viewPath + '/handoffs/' + missingId)).state, 'REJECTED');
    checks.push('Mismatched binding and tampered, incomplete or missing selected contents cannot admit a candidate');

    const requestId = 'owned-freeze-request', revision = (await runtime.snapshot()).project.revision;
    runtime.loseResponseOnce(`/v1/projects/${runtime.projectId}/submit-weft-revision`);
    await assert.rejects(runtime.command('submit-weft-revision', { ...selection }, { id: requestId, revision }), /OWNED_RESPONSE_LOST_AFTER_AUTHORITY_COMMIT/);
    const later = await weft.session('owned-deterministic-session-one', { kind: 'replace', path: 'mutation.mjs', oldText: '  invalidate();', newText: '  // Later unfinished work removes invalidation.' });
    assert.ok(later.acceptedRevision > selected.revision);
    await weft.syncPeer();
    // Restart the owned Confidence runtime, preserving its SQLite/R2 state.
    // A lost response reconciles by the original command identity and exact input.
    await runtime.connect([binding], 'owned-invalid-image-digest-for-interruption-test');
    const admitted = await runtime.command('submit-weft-revision', { ...selection }, { id: requestId, revision });
    assert.deepEqual(await runtime.command('submit-weft-revision', { ...selection }, { id: requestId, revision }), admitted);
    await runtime.command('submit-weft-revision', { ...selection, context: { note: 'changed identity input' } }, { id: requestId, revision, expected: 409 });
    fault = 'backpressure';
    await runtime.control('step');
    assert.equal((await runtime.request(viewPath + '/handoffs/' + requestId)).state, 'PENDING');
    assert.equal((await runtime.snapshot()).candidates.length, 0);
    await runtime.control('step');
    const frozen = await runtime.request(viewPath + '/handoffs/' + requestId);
    assert.equal(frozen.state, 'FROZEN'); assert.ok(frozen.sourceCommit);
    assert.equal((await runtime.snapshot()).candidates.length, 0);
    const frozenContentRequests = contentRequests;
    await runtime.connect([binding]);
    await runtime.control('drain');
    assert.equal(contentRequests, frozenContentRequests, 'Persisted frozen source must resume without reacquiring selected content');
    const handoff = await runtime.request(viewPath + '/handoffs/' + requestId); assert.equal(handoff.state, 'READY');
    assert.equal(handoff.submittedBy, runtime.issuer + '#owner'); assert.deepEqual(handoff.scope, enrollment.scope);
    const state = await runtime.snapshot(), candidate = state.candidates.find((item: AdmissionCandidate) => item.id === admitted.candidateId) as AdmissionCandidate;
    assert.ok(candidate); assert.equal(candidate.commit, handoff.sourceCommit); assert.equal(candidate.parent, runtime.git.base);
    const measured = await measureAndReport(runtime, candidate); assert.ok(measured.local.observations.every(item => item.outcome === 'PASS'));
    const frozenFiles = await runtime.git.git.files(candidate.commit);
    assert.match(frozenFiles['mutation.mjs'].toString('utf8'), /  invalidate\(\);/);
    assert.doesNotMatch(await readFile(join(weft.primary, 'mutation.mjs'), 'utf8'), /  invalidate\(\);/);
    assert.equal(await runtime.git.head(), runtime.git.base); assert.equal(runtime.git.writes(), 0);
    checks.push('Duplicate/lost-response recovery returns one candidate; selected exact source survives later accepted edits; nine real local behavioral probes pass');
    checks.push('Transient backpressure remains pending; persisted FROZEN transfer resumes after runtime restart without another selected-content acquisition');

    const badSelection = await replicaRequest(`${viewPath}/api/workspaces/${weft.workspace}/sync/revisions/${later.acceptedRevision}`);
    const failed = await runtime.command('submit-weft-revision', { ...selection, revision: badSelection.revision, root: badSelection.manifest.root });
    await runtime.control('drain');
    const badState = await runtime.snapshot(), badCandidate = badState.candidates.find((item: AdmissionCandidate) => item.id === failed.candidateId) as AdmissionCandidate;
    const failedMeasurement = await measureAndReport(runtime, badCandidate); assert.ok(failedMeasurement.local.observations.some(item => item.outcome === 'FAIL'));
    await runtime.command('prepare-review', { candidateId: badCandidate.id, evaluationId: `${badCandidate.id}-evaluation` }, { expected: 409 });
    const originalReview = await runtime.command('prepare-review', { candidateId: candidate.id, evaluationId: `${candidate.id}-evaluation` });
    await runtime.command('approve-review', { reviewId: originalReview.id, proposalDigest: originalReview.proposalDigest }, { subject: 'peer', expected: 403 });
    await runtime.command('set-policy', { contracts: ['retained-value-v1'], reason: 'Owned policy revision staleness check' });
    await runtime.command('approve-review', { reviewId: originalReview.id, proposalDigest: originalReview.proposalDigest }, { expected: 409 });
    const newEvaluation = await runtime.command('request-evaluation', { candidateId: candidate.id }); await runtime.control('drain');
    const remeasured = await measureAndReport(runtime, candidate); assert.ok(remeasured.local.observations.every(item => item.outcome === 'PASS'));
    checks.push('Measured failing live candidate cannot be reviewed; changed policy invalidates the previous review and requires fresh evaluation');
    const review = await runtime.command('prepare-review', { candidateId: candidate.id, evaluationId: newEvaluation.id });
    await rejectReplicaCommand('approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest });
    await runtime.command('approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest });
    const publicationId = 'owned-publication-request', publicationRevision = (await runtime.snapshot()).project.revision;
    const publicationBody = { reviewId: review.id, proposalDigest: review.proposalDigest };
    await rejectReplicaCommand('request-publication', publicationBody);
    const publication = await runtime.command('request-publication', publicationBody, { id: publicationId, revision: publicationRevision });
    await runtime.control('drain');
    const published = await runtime.snapshot(); assert.equal(published.publications.length, 1); assert.equal(published.publications[0].phase, 'FINALIZED');
    assert.equal(await runtime.git.head(), candidate.commit);
    assert.deepEqual(await runtime.command('request-publication', publicationBody, { id: publicationId, revision: publicationRevision }), publication);
    await runtime.control('drain'); assert.equal(runtime.git.writes(), 1);
    const bundle = await runtime.request(`/api/projects/${runtime.projectId}/receipts/${publication.id}/export`);
    const trust = await runtime.request(`/api/projects/${runtime.projectId}/trust-config`);
    const checkpoint = await runtime.request(`/api/projects/${runtime.projectId}/checkpoint`);
    const verification = verifyBundle(bundle, trust, checkpoint); assert.equal(verification.valid, true, JSON.stringify(verification));
    await runtime.command('submit-weft-revision', { ...selection }, { expected: 409 });
    checks.push('Synthetic test human approves exact review; real conditional Git receive-pack publishes once; existing portable verifier accepts receipt; old release base is stale');
    await runtime.command('set-membership', { subject: runtime.issuer + '#peer', roles: ['reader', 'sponsor'], active: false });
    await assert.rejects(weft.syncPeer());
    await runtime.request(viewPath, {}, 'peer', 404);
    await weft.assertPreserved();
    checks.push('Revoked Confidence participant loses proxy and replica access; source HEAD, index and unrelated local dirty file remain unchanged');
    await runtime.command('set-admission-gate', { gate: 'CLOSED' }); await runtime.control('drain');
    const metadata = await runtime.request(`/api/projects/${runtime.projectId}`);
    const archived = await runtime.request(`/api/projects/${runtime.projectId}/archive`, { method: 'POST',
      headers: { origin: runtime.origin, 'content-type': 'application/json', 'x-platform-csrf': '1', 'idempotency-key': 'owned-archive',
        'if-platform-revision': metadata.revision, 'if-platform-incarnation': metadata.projectIncarnation }, body: '{}',
    });
    assert.equal(archived.status, 'ARCHIVED');
    const archivedView = await runtime.request(viewPath); assert.equal(archivedView.canSubmit, false);
    assert.ok(await replicaRequest(`${viewPath}/api/workspaces/${weft.workspace}/sync`));
    const archivedEdit = await replicaRequest(`${viewPath}/api/workspaces/${weft.workspace}/prepare`, { method: 'POST',
      headers: { origin: runtime.origin, 'content-type': 'application/json', 'x-platform-csrf': '1' }, body: '{}',
    }, 'owner', 409);
    assert.equal(archivedEdit.error, 'PROJECT_ARCHIVED');
    checks.push('Native project archived through production metadata API: live state remains readable while prepare and new submission are disabled');
    checks.push('Same-human replica audience can synchronize only through the exact scoped proxy; application and mixed audiences cannot cross the credential boundary; replica credentials cannot submit, approve, publish or manage membership');
    const sessions = await weft.evidence();
    const concurrent = sessions.independentSessions.slice(0, 2);
    assert.equal(new Set(concurrent.map(session => session.pid)).size, 2);
    assert.ok(Math.max(...concurrent.map(session => session.startedAt)) < Math.min(...concurrent.map(session => session.endedAt)), 'Independent deterministic session process lifetimes must overlap');
    const afterSource = await sourceProvenance(); assert.equal(afterSource.treeDigest, source.treeDigest, 'Rehearsal code/build inputs changed during execution; rerun against a stable source closure');
    return { at: new Date().toISOString(), confidenceSource: source, confidenceBundleDigests: runtime.bundleDigests, weftSource: weft.sourceRevision,
      environment: { authority: 'production authority and application in local workerd', repository: 'production ArtifactsRepository over owned real Git transport',
        checks: 'real local external behavioral subprocesses; Cloudflare Container isolation unqualified', humanApproval: 'synthetic-test-human', identity: 'synthetic JWT issuer with production verification',
        accessIngress: 'simulated-header-forwarding-with-real-JWT-verification', trials: 'deterministic test fixed-tool fixture; no native-agent or model qualification' },
      credentialAuthority: { replicaAudience, applicationAudience: runtime.audience, attribution: 'same verified issuer and subject as the human',
        replicaAccess: 'exact scoped Weft proxy only', deniedOperations: replicaDeniedOperations,
        applicationCredentialOnProxyDenied: true, mixedAudienceDenied: true, replicaCredentialOnOtherAPIDenied: true },
      selection: { revision: selection.revision, root: selection.root, liveRevision: later.acceptedRevision, candidateId: candidate.id, commit: candidate.commit, mappingDigest: handoff.mappingDigest, frozenUnaffectedByLaterEdits: true },
      publication: { id: publication.id, logicalPublications: published.publications.length, gitReceivePackRequests: runtime.git.writes(), receiptDigest: checkpoint.receiptDigest },
      recovery: { backpressureRetried: true, frozenResumedWithoutAcquisition: true, contentRequestsAtFreeze: frozenContentRequests },
      archivedProject: { readableWithEditsDenied: true, revision: archived.revision },
      localMeasurements: { selected: measured.local, laterFailing: failedMeasurement.local, afterPolicyChange: remeasured.local },
      portableReceipt: { bundle, trustConfig: trust, checkpoint }, verification, sessions, checks };
  } finally { if (weft) await weft.dispose(); await runtime.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runWeftJourney();
  const path = resolve(process.env.WEFT_RUNTIME_REPORT || 'demo-output/weft-runtime.json'); await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ report: path, checks: result.checks.length, source: result.selection.commit, verification: result.verification, environment: result.environment }, null, 2));
}
