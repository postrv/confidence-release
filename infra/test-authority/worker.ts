// TEST ONLY. Never deploy this Worker: it exposes trusted-state seeding and a
// deliberately fake repository. Production authority code is imported unchanged.
import authorityWorker, { ProjectAuthority } from '../../workers/authority/index';
import { observeAuthorityCapacity } from '../../workers/authority/capacity';
import { canonicalize, digest, decodeBase64, getKernel, sha256 } from '../../packages/protocol/src/index';
import { assertPortableAdmission } from '../../workers/authority/portable-profile';
import { ObjectStore } from '../../workers/shared/objects';
import { uiSnapshot } from '../../workers/app/adapter';
import type { AuthorityEnv, AuthorityRead, ProjectRecord, TrustedCaller } from '../../workers/authority/types';
import type { RepositorySnapshot, FixedPublication } from '../../workers/authority/artifacts';
import { objectStoreDeadlineChecks } from './objects';

export class TestAuthority extends ProjectAuthority {
  private objectReadBarrier: Promise<void> | null = null;
  private releaseObjectReads: (() => void) | null = null;
  private pausedObjectReads = 0;
  private objectReads = 0;
  private modelRosterReads = 0;
  constructor(ctx: DurableObjectState, env: AuthorityEnv) {
    // Projection delivery is outside this test; no queue network is simulated.
    const testEnv = { ...env, EVENTS: { send: async () => { await ctx.storage.put('automatic-deliveries', (await ctx.storage.get<number>('automatic-deliveries') || 0) + 1); } }, RUNNER: { fetch: async (request: Request | string, options?: RequestInit) => { await ctx.storage.put('fake-runner-request', JSON.parse(String(options?.body || '{}'))); return Response.json({ accepted: true }); } }, EVALUATOR: { fetch: async (request: Request | string, options?: RequestInit) => {
      if (new URL(request instanceof Request ? request.url : String(request)).pathname === '/internal/operations') return Response.json({ schemaVersion: 1, scope: JSON.parse(String(options?.body || '{}')).scope, scheduler: { queued: 0, active: 0 }, generations: [], recoveryEvents: [], ownedFakeEvaluator: true });
      const selected = await ctx.storage.get<string>('fake-evaluator-pending-job');
      if (selected && JSON.parse(String(options?.body || '{}')).job?.id === selected) return new Promise<Response>(() => {});
      return await ctx.storage.get<boolean>('fake-evaluator-unavailable') ? new Response('Owned evaluator temporarily unavailable', { status: 503 }) : Response.json({ accepted: true });
    } } } as unknown as AuthorityEnv;
    super(ctx, testEnv);
    // Test-only scheduling barrier for revocation during an actual R2 read.
    const objects = (this as any).objects as ObjectStore; const get = objects.get.bind(objects);
    objects.get = async (...args: Parameters<ObjectStore['get']>) => {
      this.objectReads++;
      if (this.objectReadBarrier) { this.pausedObjectReads++; await this.objectReadBarrier; }
      return get(...args);
    };
    const putJournal = objects.putJournal.bind(objects);
    objects.putJournal = async (key, value) => {
      const result = await putJournal(key, value);
      const fault = key.endsWith('/prepared') ? await ctx.storage.get<{ legacy: boolean; corrupt: boolean }>('prepared-write-fault') : null;
      if (fault) {
        await ctx.storage.delete('prepared-write-fault'); await ctx.storage.put('prepared-write-fault-observed', true);
        if (fault.legacy) {
          const row = ctx.storage.sql.exec<{ id: string; payload: string }>("SELECT id,payload FROM publications WHERE phase='ADMITTED'").one(); const retained = JSON.parse(row.payload);
          delete retained.preparedDescriptor; delete retained.admission;
          ctx.storage.sql.exec('UPDATE publications SET payload=? WHERE id=?', canonicalize(retained), row.id);
        }
        if (fault.corrupt) { const descriptor = JSON.parse(new TextDecoder().decode(value)); descriptor.oldHead = '0'.repeat(40); await env.OBJECTS.put(key, canonicalize(descriptor)); }
        throw new Error('Owned failure after real prepared R2 write and before READY SQLite transition');
      }
      return result;
    };
    (this as any).repository = {
      head: async () => await ctx.storage.get<string>('fake-head') ?? null,
      conditionalPublish: async (_name: string, operation: FixedPublication) => {
        const dispatches = await ctx.storage.get<FixedPublication[]>('fake-dispatches') ?? [];
        dispatches.push(operation); await ctx.storage.put('fake-dispatches', dispatches);
        const head = await ctx.storage.get<string>('fake-head');
        if (head !== operation.oldHead) throw new Error('Owned fake old-head rejection');
        await ctx.storage.put('fake-pending-operation', operation);
        // Transport intentionally loses the response before the fake delayed
        // update. Seeing B must leave the authority's publication unresolved.
        throw new Error('Owned fake lost response; effect is deliberately delayed');
      },
      ingest: async (_name: string, _ref: string, expected: string) => {
        const source = await ctx.storage.get<RepositorySnapshot>('fake-source');
        if (!source || source.commit !== expected) throw new Error('Owned fake source not available');
        return source;
      },
      attemptPresent: async () => !(await ctx.storage.get<boolean>('fake-attempt-absent')),
      revokeAttemptCredentials: async () => { await ctx.storage.put('fake-credentials-revoked', true); return true; },
      deleteAttempt: async () => {
        await ctx.storage.put('fake-delete-dispatches', (await ctx.storage.get<number>('fake-delete-dispatches') || 0) + 1);
        throw new Error('Owned fake lost delete acknowledgment; absence is deliberately delayed');
      },
    };
  }
  // Only timing is controlled. drain() invokes the real production dispatcher.
  override async alarm(): Promise<void> {}
  protected override modelCallRoster(project: ProjectRecord): NonNullable<AuthorityRead['modelCalls']> {
    this.modelRosterReads++;
    return super.modelCallRoster(project);
  }
  async settleOwnedModelCall(input: { attemptId: string; callId: string }): Promise<unknown> {
    // Synthetic settlement exercises the durable admission bound, not billing.
    const row = this.ctx.storage.sql.exec<{ maximum: string; state: string }>(
      'SELECT maximum,state FROM reservations WHERE id=? AND owner=? AND id != owner', input.callId, input.attemptId).one();
    if (row.maximum !== '100000' || row.state !== 'DISPATCHED') throw new Error('Owned dispatched model call required');
    this.ctx.storage.sql.exec("UPDATE reservations SET state='SETTLED',settled='0' WHERE id=? AND owner=?", input.callId, input.attemptId);
    return this.inspect();
  }
  async reverseReviewIdentifiers(): Promise<unknown> {
    const rows = this.ctx.storage.sql.exec<{ rowid: number; payload: string }>("SELECT rowid,payload FROM records WHERE kind='review' ORDER BY rowid").toArray();
    if (rows.length !== 2) throw new Error('Owned review pair required');
    for (const [index, row] of rows.entries()) {
      const review = { ...JSON.parse(row.payload), id: index ? 'aa-owned-newer' : 'zz-owned-older' };
      this.ctx.storage.sql.exec("UPDATE records SET id=?,payload=?,digest=? WHERE rowid=?", review.id, canonicalize(review), await digest(review), row.rowid);
    } return this.inspect();
  }
  async armPreparedFault(input: { legacy?: boolean; corrupt?: boolean }): Promise<unknown> {
    await this.ctx.storage.put('prepared-write-fault', { legacy: Boolean(input.legacy), corrupt: Boolean(input.corrupt) }); return { state: 'ARMED' };
  }
  async setOwnedPublicationSequence(input: { sequence: string }): Promise<unknown> {
    const project = (this as any).project(); const old = project.revision; project.publicationSequence = input.sequence; project.revision = (BigInt(old) + 1n).toString(); (this as any).saveProject(project, old); return this.inspect();
  }
  async portableProfile(input: { bytes: number; history: number }): Promise<unknown> { assertPortableAdmission(input.bytes, input.history); return { state: 'WITHIN_PROFILE' }; }
  async seedArchiveHistory(input: { sources: number; evidence: number }): Promise<unknown> {
    const source = await this.ctx.storage.get<RepositorySnapshot>('fake-source'); if (!source) throw new Error('Owned source unavailable');
    const observation = { retained: 'owned-large-archive' }; const store = new ObjectStore(this.env.OBJECTS);
    const observationDigest = await store.put(new TextEncoder().encode(canonicalize(observation)));
    const envelope = { payloadType: 'owned-archive-only', payload: '', signatures: [] }; await store.put(new TextEncoder().encode(canonicalize(envelope)));
    this.ctx.storage.transactionSync(() => {
      for (let index = 0; index < input.sources; index++) (this as any).retain('source', `owned-source-alias-${index}`, source);
      for (let index = 0; index < input.evidence; index++) {
        const digest = `sha256:${index.toString(16).padStart(64, '0')}`;
        (this as any).retain('evidence-envelope-digest', digest, envelope);
        this.ctx.storage.sql.exec('INSERT INTO evidence(job_id,digest,outcome,payload) VALUES(?,?,?,?)', `owned-archived-evidence-${index}`, digest, 'PASS', canonicalize({ digest, observationDigest }));
      }
    }); return this.inspect();
  }
  async armRestartProbe(): Promise<unknown> {
    (this as any).effect('owned-alarm-crash-window', 'projection', { id: 'owned-alarm-crash-window', scope: (this as any).project().scope });
    await this.ctx.storage.deleteAlarm(); return this.inspect();
  }
  capacityState(): unknown {
    const query = (table: string) => this.ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray();
    return { capacity: observeAuthorityCapacity(this.ctx.storage.sql), project: (this as any).project(), pausedObjectReads: this.pausedObjectReads, objectReads: this.objectReads,
      commands: query('commands'), events: query('events'), outbox: query('outbox'), reservations: query('reservations'), grants: query('grants'),
      approvals: query('approvals'), publications: query('publications'), receipts: query('receipts'), cleanups: query('cleanups'), pins: query('pins') };
  }
  seedCapacity(input: { records: number }): unknown {
    if (!Number.isSafeInteger(input.records) || input.records < 0 || input.records > 20000) throw new Error('Owned capacity fixture bound');
    const count = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM records').one().count;
    const existing = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM records WHERE kind='owned-capacity'").one().count;
    const added = input.records - count; if (added < 0) throw new Error('Owned capacity fixture never deletes history');
    if (added) this.ctx.storage.sql.exec("WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<?) INSERT INTO records(kind,id,digest,payload) SELECT 'owned-capacity',printf('owned-capacity-%06d',n+?),'sha256:'||printf('%064d',0),'{}' FROM numbers", added, existing);
    return this.capacityState();
  }
  async seedLegacyOutboxAge(): Promise<unknown> {
    this.ctx.storage.sql.exec("DROP TABLE outbox; CREATE TABLE outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'PENDING',attempts INTEGER NOT NULL DEFAULT 0)");
    const payload = { scope: (this as any).project().scope, ownedLegacy: true };
    this.ctx.storage.sql.exec("INSERT INTO outbox(id,kind,digest,payload,state) VALUES(?,?,?,?, 'PENDING')", 'owned-legacy-outbox-age', 'projection', await digest(payload), canonicalize(payload));
    return this.inspect();
  }
  async addOwnedOutboxAgeEffect(): Promise<unknown> {
    (this as any).effect('owned-new-outbox-age', 'projection', { scope: (this as any).project().scope, ownedNew: true }); return this.inspect();
  }
  async deliverLegacyOutboxAge(): Promise<unknown> {
    this.ctx.storage.sql.exec("UPDATE outbox SET state='DELIVERED' WHERE id='owned-legacy-outbox-age'"); return this.inspect();
  }
  async pauseObjectReads(): Promise<unknown> {
    if (this.objectReadBarrier) throw new Error('Owned R2 barrier already set');
    this.pausedObjectReads = 0; this.objectReadBarrier = new Promise<void>(release => { this.releaseObjectReads = release; }); return { state: 'PAUSED' };
  }
  async resumeObjectReads(): Promise<unknown> { this.releaseObjectReads?.(); this.objectReadBarrier = null; this.releaseObjectReads = null; return { state: 'RESUMED' }; }
  async drain(): Promise<unknown> {
    for (let batch = 0; batch < 16; batch++) {
      const pending = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE state='PENDING'").one().count;
      if (!pending) break;
      await super.alarm();
    }
    if (this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE state='PENDING'").one().count) throw new Error('Owned drain batch bound exceeded');
    await this.ctx.storage.deleteAlarm(); return this.inspect();
  }
  async advanceOnce(): Promise<unknown> { await ProjectAuthority.prototype.alarm.call(this); await this.ctx.storage.deleteAlarm(); return this.inspect(); }
  async setEvaluatorUnavailable(input: { unavailable: boolean }): Promise<unknown> { await this.ctx.storage.put('fake-evaluator-unavailable', input.unavailable); return this.inspect(); }
  async setEvaluatorPending(input: { jobId: string | null }): Promise<unknown> { await this.ctx.storage.put('fake-evaluator-pending-job', input.jobId); return this.inspect(); }
  async applicationSnapshot(caller: TrustedCaller, candidateId?: string): Promise<unknown> { return uiSnapshot(await this.snapshot(caller, false, candidateId), { pi: true, publication: true }); }
  async seedCandidateReadHistory(input: { candidateId: string; evidence: any }): Promise<unknown> {
    const authority = this as any, project = authority.project(), candidate = authority.record('candidate', input.candidateId);
    const emptyManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [] };
    this.ctx.storage.transactionSync(() => {
      // Owned metadata filler only. No checker or provider outcome is claimed.
      for (let index = 0; index < 2048; index++) {
        const id = `000-history-${String(index).padStart(4, '0')}`, commit = index.toString(16).padStart(40, '0');
        const source = { ...candidate.source, commit, manifest: emptyManifest };
        authority.retain('candidate', id, { ...candidate, id, commit, contributorIds: [], recipe: [], source });
        authority.retain('source', commit, source);
        authority.retain('attempt', id, { id, generation: '1', workBase: project.head, publicationBase: project.head, allowedPaths: [] });
        authority.retain('plan', id, { candidateId: id, candidateDigest: candidate.digest, digest: `history-plan-${index}`, jobs: [] });
        authority.retain('evaluation', id, { ...authority.evaluationContext(project, id), planDigest: `history-plan-${index}`, authorityRevision: '1' });
        if (index < 512) {
          const evidence = { ...input.evidence, id, jobId: id, candidateId: id, digest: `sha256:${(index + 1000).toString(16).padStart(64, '0')}` };
          this.ctx.storage.sql.exec('INSERT INTO evidence(job_id,digest,outcome,payload) VALUES(?,?,?,?)', id, evidence.digest, evidence.outcome, canonicalize(evidence));
        }
      }
      const submissions: string[] = [];
      for (const role of ['a', 'b']) {
        const id = `zz-current-${role}`, submissionId = id + '-submission'; submissions.push(submissionId);
        authority.retain('attempt', id, { id, generation: '1', grantId: id, deadline: 1000, workBase: project.head, publicationBase: project.head, allowedPaths: [role === 'a' ? 'cache.mjs' : 'mutation.mjs'] });
        authority.retain('submission', submissionId, { attemptId: id, source: candidate.source });
        authority.retain('runtime-observation', id, { attemptId: id, generation: '1', lifecycle: 'STOPPED', outcome: 'COMPLETED' });
        authority.event(project, 'create-attempt', id, { id });
      }
      const selected = { ...candidate, contributorIds: submissions, recipe: submissions };
      this.ctx.storage.sql.exec("UPDATE records SET payload=? WHERE kind='candidate' AND id=?", canonicalize(selected), candidate.id);
      authority.event(project, 'candidate-ready', candidate.id, { commit: candidate.commit });
      authority.retain('candidate', 'zz-diagnostic', { ...selected, id: 'zz-diagnostic', recipe: ['controlled-A-plus-B'] });
      authority.event(project, 'candidate-ready', 'zz-diagnostic', {});
      authority.retain('candidate', 'zz-first-individual', { ...selected, id: 'zz-first-individual', contributorIds: [submissions[0]], recipe: [submissions[0]] });
      authority.event(project, 'candidate-ready', 'zz-first-individual', {});
      for (let index = 0; index < 257; index++) authority.event(project, 'owned-unrelated-history', `unrelated-${index}`, {});
    });
    return { candidateId: candidate.id, recordsPerKind: 2048, primaryEvidencePrefix: 512, unrelatedEvents: 257 };
  }
  async addCandidateReadRepair(input: { candidateId: string }): Promise<unknown> {
    const authority = this as any, project = authority.project(), source = authority.record('candidate', input.candidateId);
    const attemptId = 'zz-latest-repair', submissionId = attemptId + '-submission', candidateId = 'zz-repair-individual';
    this.ctx.storage.transactionSync(() => {
      authority.retain('attempt', attemptId, { id: attemptId, generation: '1', grantId: attemptId, deadline: 1000, workBase: source.commit, publicationBase: source.parent, allowedPaths: ['cache.mjs'] });
      authority.retain('submission', submissionId, { attemptId, source: source.source });
      authority.event(project, 'start-repair', 'owned-repair-command', { id: attemptId, state: 'REPAIR_RESERVED' });
      authority.retain('candidate', candidateId, { ...source, id: candidateId, contributorIds: [...source.contributorIds, submissionId], recipe: [submissionId] });
      authority.event(project, 'candidate-ready', candidateId, {});
      for (let index = 0; index < 257; index++) authority.event(project, 'owned-unrelated-history', `after-repair-${index}`, {});
    });
    return { candidateId, attemptId };
  }
  async addCandidateReadPendingRepairs(input: { candidateId: string }): Promise<unknown> {
    const authority = this as any, project = authority.project(), source = authority.record('candidate', input.candidateId);
    this.ctx.storage.transactionSync(() => {
      for (const [id, lifecycle, outcome] of [['zz-earlier-repair', 'STOPPED', 'FAILED'], ['aa-later-repair', 'RUNNING', 'PENDING']]) {
        authority.retain('attempt', id, { id, generation: '1', grantId: id, deadline: 1000, workBase: source.commit, publicationBase: source.parent, allowedPaths: ['cache.mjs'] });
        authority.retain('runtime-observation', id, { attemptId: id, generation: '1', lifecycle, outcome });
        authority.event(project, 'start-repair', id + '-command', { id, state: 'REPAIR_RESERVED' });
      }
      for (let index = 0; index < 257; index++) authority.event(project, 'owned-unrelated-history', `pending-repair-${index}`, {});
    });
    return { latestAttemptId: 'aa-later-repair' };
  }
  async overflowCandidateRead(input: { candidateId: string; evidence: any; count: number }): Promise<unknown> {
    const authority = this as any, project = authority.project();
    if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 130) throw Error('OWNED_COUNT_INVALID');
    const rows = await Promise.all(Array.from({ length: input.count }, async (_, index) => {
      const id = `zz-extra-${input.candidateId}-${String(index).padStart(4, '0')}`;
      const { digest: ignored, ...prior } = input.evidence;
      const base = { ...prior, id, jobId: id, candidateId: input.candidateId };
      return { ...base, digest: await digest(base) };
    }));
    this.ctx.storage.transactionSync(() => {
      for (const evidence of rows) {
        this.ctx.storage.sql.exec('INSERT INTO evidence(job_id,digest,outcome,payload) VALUES(?,?,?,?)', evidence.jobId, evidence.digest, evidence.outcome, canonicalize(evidence));
      }
      authority.event(project, 'owned-evidence-prefix', input.candidateId, {});
    });
    return { count: input.count };
  }
  async emitOwnedDisplayEvent(): Promise<unknown> {
    const project = (this as any).project(); (this as any).event(project, 'owned-display-failure', 'owned-event', { outcome: 'FAIL' });
    return { revision: project.revision };
  }
  async retainOwnedLateCapsule(): Promise<unknown> {
    const project = (this as any).project();
    (this as any).retain('context-capsule', 'owned-late-capsule', {
      id: 'owned-late-capsule', scope: project.scope, attemptId: 'owned-attempt', generation: '1',
      sourceCommit: project.head, sourceManifestDigest: 'sha256:' + '1'.repeat(64), goalRevision: project.goalRevision,
      adapter: 'owned-test', selectorVersion: 'owned-test', sessionDigest: null, renderedContextDigest: 'sha256:' + '2'.repeat(64),
      selectedItems: [], missingSessionTail: true, digest: 'sha256:' + '3'.repeat(64),
    });
    return { revision: project.revision };
  }
  async removeOwnedObservation(): Promise<unknown> {
    const row = this.ctx.storage.sql.exec<{ payload: string }>('SELECT payload FROM evidence LIMIT 1').one();
    const digest = (JSON.parse(row.payload) as { observationDigest: string }).observationDigest;
    await this.env.OBJECTS.delete(new ObjectStore(this.env.OBJECTS).key(digest));
    return { removed: true };
  }
  async seedRuntimeHistory(input: { attemptId: string }): Promise<unknown> {
    const attempt = (this as any).record('attempt', input.attemptId);
    this.ctx.storage.transactionSync(() => {
      for (let index = 0; index < 2048; index++) {
        const eventId = `owned-history-${String(index).padStart(4, '0')}`;
        (this as any).retain('runtime-observation', eventId, { scope: (this as any).project().scope, attemptId: attempt.id, generation: attempt.generation, eventId, lifecycle: 'START_MAY_HAVE_DISPATCHED', outcome: 'PENDING', verified: true });
      }
    });
    return { state: 'OWNED_RUNTIME_PREFIX_SEEDED' };
  }
  async settleOwnedEffects(): Promise<unknown> {
    this.ctx.storage.sql.exec("UPDATE outbox SET state='DELIVERED' WHERE kind IN ('provision-attempt','start-attempt','stop-attempt')"); return this.inspect();
  }
  async setFakeAttemptAbsent(): Promise<unknown> { await this.ctx.storage.put('fake-attempt-absent', true); return this.inspect(); }
  async removeArchiveBlob(): Promise<unknown> {
    const source = await this.ctx.storage.get<RepositorySnapshot>('fake-source'); if (!source) throw new Error('Owned source unavailable');
    const reference = source.manifest.entries[0]?.digest; if (!reference) throw new Error('Owned blob unavailable');
    await this.env.OBJECTS.delete(new ObjectStore(this.env.OBJECTS).key(reference)); return this.inspect();
  }
  async restoreArchiveBlob(): Promise<unknown> {
    const source = await this.ctx.storage.get<RepositorySnapshot>('fake-source'); if (!source) throw new Error('Owned source unavailable');
    const raw = await new ObjectStore(this.env.OBJECTS).get(source.objectsDigest, 8 * 1024 * 1024); const gitObjects = JSON.parse(new TextDecoder().decode(raw));
    const blob = gitObjects.find((item: any) => item.type === 'blob'); await new ObjectStore(this.env.OBJECTS).put(decodeBase64(blob.dataBase64), source.manifest.entries[0].digest); return this.inspect();
  }
  async removeReceiptJournal(): Promise<unknown> {
    const row = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM publications WHERE phase='FINALIZED' LIMIT 1").one();
    const publication = JSON.parse(row.payload); await this.env.OBJECTS.delete(`journal/${(this as any).project().scope.projectIncarnation}/${publication.id}/receipt`); return this.inspect();
  }
  async restoreReceiptJournal(): Promise<unknown> {
    const row = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM publications WHERE phase='FINALIZED' LIMIT 1").one();
    const publication = JSON.parse(row.payload); await new ObjectStore(this.env.OBJECTS).putJournal(`journal/${(this as any).project().scope.projectIncarnation}/${publication.id}/receipt`, new TextEncoder().encode(canonicalize(publication.envelope))); return this.inspect();
  }
  async verifyOwnedCleanupArchive(): Promise<unknown> {
    const cleanup = this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM cleanups LIMIT 1').one();
    return (this as any).verifyCleanupArchive(cleanup.id);
  }
  async seed(input: any): Promise<unknown> {
    const store = new ObjectStore(this.env.OBJECTS);
    const source: RepositorySnapshot = { commit: input.candidate.commit, commitBytesDigest: input.candidate.commitBytesDigest, parent: input.candidate.parent, manifest: input.manifest, manifestDigest: input.candidate.manifestDigest, objects: [], objectsDigest: await store.put(new TextEncoder().encode(canonicalize(input.gitObjects))) };
    const baselineSource: RepositorySnapshot | null = input.baselineSource ? { commit: input.baselineSource.commit, commitBytesDigest: input.baselineSource.commitBytesDigest, parent: input.baselineSource.parent, manifest: input.baselineSource.manifest, manifestDigest: input.baselineSource.manifestDigest, objects: [], objectsDigest: await store.put(new TextEncoder().encode(canonicalize(input.baselineSource.gitObjects))) } : null;
    await store.put(new TextEncoder().encode(canonicalize(input.manifest)), input.candidate.manifestDigest);
    const byDigest = new Map<string, Uint8Array>();
    for (const object of input.gitObjects as Array<{ type: string; dataBase64: string }>) {
      if (object.type !== 'blob') continue;
      const raw = decodeBase64(object.dataBase64);
      byDigest.set(await sha256(raw), raw);
    }
    for (const entry of input.manifest.entries) {
      const raw = byDigest.get(entry.digest);
      if (!raw) throw new Error('Owned source blob missing');
      await store.put(raw, entry.digest);
    }
    const settledReservations = input.settledReservations ?? 0;
    const project = { scope: input.scope, revision: '1', head: input.cleanupHeadIsCandidate ? input.candidate.commit : input.candidate.parent, gate: input.gate === 'CLOSED' ? 'CLOSED' : 'OPEN', policyRevision: '1', goalRevision: '1', observationRevision: '0', publicationSequence: '0', unresolvedPublicationId: null, canonicalRepo: 'owned-fake-repository', canonicalRef: 'refs/heads/main', enrollmentDigest: await digest(input.enrollmentPredicate), enrollment: input.enrollment, previousReceiptDigest: null, maximumBudget: input.maximumBudget ?? '2000000', reservedBudget: '0', settledBudget: String(settledReservations * 400000) };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO project(singleton,revision,payload) VALUES(1,?,?)', project.revision, canonicalize(project));
      this.ctx.storage.sql.exec('INSERT INTO memberships(subject,roles,active) VALUES(?,?,1)', 'human-1', canonicalize(['admin', 'export', 'reader', 'reviewer', 'sponsor']));
      for (let index = 0; index < settledReservations; index++) this.ctx.storage.sql.exec('INSERT INTO reservations(id,owner,maximum,state,settled,payload) VALUES(?,?,?,?,?,?)', `owned-settled-${index}`, `owned-settled-${index}`, '400000', 'SETTLED', '400000', canonicalize({ testOnlyHistoricalReservation: index }));
      (this as any).retain('trust', 'current', input.trust);
      (this as any).retain('candidate', input.candidate.id, { ...input.candidate, scope: input.scope, source, contributorIds: [], recipe: ['test-only-synthetic-fixture'] });
      (this as any).retain('source', source.commit, source);
      if (!input.cleanupHeadIsCandidate) (this as any).retain('source', project.head, baselineSource ?? { ...source, commit: project.head, parent: null });
      (this as any).retain('plan', 'plan-1', input.plan);
      (this as any).retain('evaluation', 'plan-1', { ...(this as any).evaluationContext(project, 'plan-1'), planDigest: input.plan.digest, authorityRevision: '1' });
      for (const job of input.plan.jobs) (this as any).retain('evaluation-job', job.id, { evaluationId: 'plan-1', candidateId: input.candidate.id, inputDigest: job.inputDigest, audit: (input.auditJobIds || []).includes(job.id) });
    });
    await this.ctx.storage.put('fake-source', source); await this.ctx.storage.put('fake-head', project.head); return this.inspect();
  }
  async completeFakeEffect(): Promise<unknown> {
    const operation = await this.ctx.storage.get<FixedPublication>('fake-pending-operation');
    if (!operation) throw new Error('No owned fake delayed effect exists');
    const current = await this.ctx.storage.get<string>('fake-head');
    if (current !== operation.oldHead && current !== operation.newHead) throw new Error('Owned fake divergence');
    await this.ctx.storage.put('fake-head', operation.newHead); return this.inspect();
  }
  async setOwnedSigners(input: Partial<AuthorityEnv>): Promise<unknown> { for (const key of ['ROOT_SIGNING_KEY', 'ROOT_KEY_ID', 'AUTHORITY_SIGNING_KEY', 'AUTHORITY_KEY_ID'] as const) if (input[key]) this.env[key] = input[key]!; return { state: 'OWNED_TEST_SIGNERS_SET' }; }
  async prepareOwnedEnrollment(input: any): Promise<unknown> {
    const store = new ObjectStore(this.env.OBJECTS); const source: RepositorySnapshot = { commit: input.candidate.commit, commitBytesDigest: input.candidate.commitBytesDigest, parent: input.candidate.parent, manifest: input.manifest, manifestDigest: input.candidate.manifestDigest, objects: [], objectsDigest: await store.put(new TextEncoder().encode(canonicalize(input.gitObjects))) };
    await store.put(new TextEncoder().encode(canonicalize(input.manifest)), source.manifestDigest);
    for (const entry of source.manifest.entries) { const blob = input.gitObjects.find((item: any) => item.type === 'blob'); await store.put(decodeBase64(blob.dataBase64), entry.digest); }
    await this.ctx.storage.put('fake-source', source); await this.ctx.storage.put('fake-head', source.commit); return { state: 'OWNED_ENROLLMENT_SOURCE_READY' };
  }
  async addOwnedCandidate(input: any): Promise<unknown> {
    const validation = JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: input.candidate, manifest: input.manifest, gitObjects: input.gitObjects }))); if (!validation.valid) throw new Error(validation.reason);
    const store = new ObjectStore(this.env.OBJECTS); const source: RepositorySnapshot = { commit: input.candidate.commit, commitBytesDigest: input.candidate.commitBytesDigest, parent: input.candidate.parent, manifest: input.manifest, manifestDigest: input.candidate.manifestDigest, objects: [], objectsDigest: await store.put(new TextEncoder().encode(canonicalize(input.gitObjects))) };
    await store.put(new TextEncoder().encode(canonicalize(input.manifest)), source.manifestDigest); await this.ctx.storage.put('fake-source', source);
    const project = (this as any).project(); (this as any).retain('candidate', input.candidate.id, { ...input.candidate, scope: project.scope, source, contributorIds: [], recipe: ['owned-history-regression'] }); (this as any).retain('source', source.commit, source);
    if (!input.plan) return this.inspect();
    (this as any).retain('plan', input.planId, input.plan); (this as any).retain('evaluation', input.planId, { ...(this as any).evaluationContext(project, input.planId), planDigest: input.plan.digest, authorityRevision: project.revision });
    for (const job of input.plan.jobs) (this as any).retain('evaluation-job', job.id, { evaluationId: input.planId, candidateId: input.candidate.id, inputDigest: job.inputDigest, audit: false }); return this.inspect();
  }
  async advanceOwnedHead(input: { commit: string }): Promise<unknown> {
    (this as any).record('source', input.commit); const project = (this as any).project(); const original = project.revision; project.head = input.commit; project.revision = (BigInt(original) + 1n).toString(); (this as any).saveProject(project, original); return this.inspect();
  }
  async putOwnedObject(input: { dataBase64: string }): Promise<unknown> { return { digest: await new ObjectStore(this.env.OBJECTS).put(decodeBase64(input.dataBase64)) }; }
  async removeOwnedObject(input: { digest: string }): Promise<unknown> { await this.env.OBJECTS.delete(new ObjectStore(this.env.OBJECTS).key(input.digest)); return { removed: input.digest }; }
  async bindOwnedSubmission(input: { attemptId: string; submissionId: string; candidateId: string }): Promise<unknown> {
    const source = await this.ctx.storage.get<RepositorySnapshot>('fake-source'); if (!source) throw new Error('Owned source unavailable');
    (this as any).retain('submission', input.submissionId, { attemptId: input.attemptId, source });
    const row = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM records WHERE kind='candidate' AND id=?", input.candidateId).one(); const candidate = { ...JSON.parse(row.payload), contributorIds: [input.submissionId] };
    this.ctx.storage.sql.exec("UPDATE records SET payload=?,digest=? WHERE kind='candidate' AND id=?", canonicalize(candidate), await digest(candidate), input.candidateId); return this.inspect();
  }
  async inspectMembership(): Promise<unknown> {
    return { memberships: this.ctx.storage.sql.exec('SELECT * FROM memberships ORDER BY subject').toArray(), events: this.ctx.storage.sql.exec('SELECT * FROM events ORDER BY sequence').toArray() };
  }
  async inspect(): Promise<unknown> {
    const query = (table: string) => this.ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray();
    return { project: query('project'), commands: query('commands'), publications: query('publications'), receipts: query('receipts'), approvals: query('approvals'), evidence: query('evidence'), records: query('records'), grants: query('grants'), reservations: query('reservations'), cleanups: query('cleanups'), cleanupArchives: query('cleanup_archives'), outbox: query('outbox'), pins: query('pins'), alarm: await this.ctx.storage.getAlarm(), automaticDeliveries: await this.ctx.storage.get('automatic-deliveries') || 0, fakeRunnerRequest: await this.ctx.storage.get('fake-runner-request'), pausedObjectReads: this.pausedObjectReads, objectReads: this.objectReads, modelRosterReads: this.modelRosterReads, preparedWriteFaultObserved: await this.ctx.storage.get('prepared-write-fault-observed') || false, fakeHead: await this.ctx.storage.get('fake-head'), dispatches: await this.ctx.storage.get('fake-dispatches') ?? [], deleteDispatches: await this.ctx.storage.get('fake-delete-dispatches') || 0, credentialsRevoked: await this.ctx.storage.get('fake-credentials-revoked') || false };
  }
}

/** Only this owned case uses actual runtime alarm delivery and production dispatch. */
export class WakeAuthority extends TestAuthority {
  override async alarm(): Promise<void> { await ProjectAuthority.prototype.alarm.call(this); }
}

async function authorityIngressChecks(env: AuthorityEnv): Promise<string[]> {
  const tokens = { APP_SERVICE_TOKEN: 'owned-app-fixture-token', EVALUATOR_SERVICE_TOKEN: 'owned-evaluator-fixture-token', RUNNER_SERVICE_TOKEN: 'owned-runner-fixture-token' };
  const lookups: string[] = [], dispatches: { operation: string; body: unknown }[] = [];
  const ingressEnv = { ...env, ...tokens, PROJECTS: { getByName: (name: string) => { lookups.push(name); return { api: (operation: string, body: unknown) => { dispatches.push({ operation, body }); return Response.json({ retained: true }); } }; } } } as unknown as AuthorityEnv;
  const scope = { schemaVersion: 1, tenantId: 'owned-tenant', projectId: 'owned-project', projectIncarnation: 'owned-incarnation' };
  const fact = { schemaVersion: 1, scope, attemptId: 'owned-attempt', generation: '1', callId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', phase: 'DISPATCH', observationDigest: 'sha256:' + '1'.repeat(64) };
  for (const test of [
    { token: tokens.APP_SERVICE_TOKEN, status: 401 }, { token: tokens.EVALUATOR_SERVICE_TOKEN, status: 401 },
    { token: tokens.RUNNER_SERVICE_TOKEN, method: 'GET', status: 405 }, { token: tokens.RUNNER_SERVICE_TOKEN, query: '?extra=1', status: 405 },
    { token: tokens.RUNNER_SERVICE_TOKEN, body: JSON.stringify({ ...fact, padding: 'x'.repeat(2048) }), status: 413 },
  ]) {
    const response = await authorityWorker.fetch(new Request('https://authority.internal/internal/runner/model-call-fact' + (test.query ?? ''), { method: test.method ?? 'POST', headers: { authorization: `Bearer ${test.token}`, 'content-type': 'application/json' }, ...(test.method === 'GET' ? {} : { body: test.body ?? JSON.stringify(fact) }) }), ingressEnv);
    if (response.status !== test.status || lookups.length || dispatches.length) throw new Error('Owned authority ingress denial failed');
  }
  const response = await authorityWorker.fetch(new Request('https://authority.internal/internal/runner/model-call-fact', { method: 'POST', headers: { authorization: `Bearer ${tokens.RUNNER_SERVICE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(fact) }), ingressEnv);
  if (response.status !== 200 || canonicalize(lookups) !== canonicalize(['owned-tenant/owned-project']) || canonicalize(dispatches) !== canonicalize([{ operation: 'model-call-fact', body: fact }])) throw new Error('Owned authority exact ingress routing failed');
  return ['Production authority service ingress rejects APP/evaluator credentials, GET, query and oversized fact bodies before any project lookup; exact runner POST routes only model-call-fact'];
}

export default {
  async fetch(request: Request, env: AuthorityEnv & { WAKE: DurableObjectNamespace<WakeAuthority> }): Promise<Response> {
    const ownedCase = new URL(request.url).searchParams.get('case') || 'publication';
    if (!/^[a-z-]{1,32}$/.test(ownedCase)) return Response.json({ error: 'INVALID_OWNED_CASE' }, { status: 400 });
    const authority = (ownedCase === 'wake' ? env.WAKE : env.PROJECTS).getByName(`owned-authority-runtime-${ownedCase}`) as DurableObjectStub<TestAuthority>;
    try {
      const path = new URL(request.url).pathname; const body: any = request.method === 'POST' ? await request.json() : {};
      let result: unknown;
      if (path === '/authority-ingress-checks') result = await authorityIngressChecks(env);
      else if (path === '/seed-capacity') result = await authority.seedCapacity(body);
      else if (path === '/capacity-state') result = await authority.capacityState();
      else if (path === '/seed') result = await authority.seed(body);
      else if (path === '/arm-prepared-fault') result = await authority.armPreparedFault(body);
      else if (path === '/set-owned-publication-sequence') result = await authority.setOwnedPublicationSequence(body);
      else if (path === '/portable-profile') result = await authority.portableProfile(body);
      else if (path === '/seed-archive-history') result = await authority.seedArchiveHistory(body);
      else if (path === '/arm-restart-probe') result = await authority.armRestartProbe();
      else if (path === '/seed-legacy-outbox-age') result = await authority.seedLegacyOutboxAge();
      else if (path === '/add-owned-outbox-age-effect') result = await authority.addOwnedOutboxAgeEffect();
      else if (path === '/deliver-legacy-outbox-age') result = await authority.deliverLegacyOutboxAge();
      else if (path === '/api-attempt-context') return authority.api('attempt-context', body);
      else if (path === '/api-command') return authority.api('command', body);
      else if (path === '/inspect-membership') result = await authority.inspectMembership();
      else if (path === '/api-candidate-source') return authority.api('candidate-source', body);
      else if (path === '/reverse-review-identifiers') result = await authority.reverseReviewIdentifiers();
      else if (path === '/api-snapshot') return authority.api('snapshot', body);
      else if (path === '/api-operations') return authority.api('operations', body);
      else if (path === '/api-model-calls') return authority.api('model-calls', body);
      else if (path === '/api-model-call-fact') return authority.api('model-call-fact', body);
      else if (path === '/api-conditional-snapshot') return authority.api('conditional-snapshot', body);
      else if (path === '/emit-owned-display-event') result = await authority.emitOwnedDisplayEvent();
      else if (path === '/retain-owned-late-capsule') result = await authority.retainOwnedLateCapsule();
      else if (path === '/remove-owned-observation') result = await authority.removeOwnedObservation();
      else if (path === '/application-snapshot') result = await authority.applicationSnapshot(body.caller, body.candidateId);
      else if (path === '/seed-candidate-read-history') result = await authority.seedCandidateReadHistory(body);
      else if (path === '/add-candidate-read-repair') result = await authority.addCandidateReadRepair(body);
      else if (path === '/add-candidate-read-pending-repairs') result = await authority.addCandidateReadPendingRepairs(body);
      else if (path === '/overflow-candidate-read') result = await authority.overflowCandidateRead(body);
      else if (path === '/seed-runtime-history') result = await authority.seedRuntimeHistory(body);
      else if (path === '/api-export') return authority.api('export', body);
      else if (path === '/pause-object-reads') result = await authority.pauseObjectReads();
      else if (path === '/resume-object-reads') result = await authority.resumeObjectReads();
      else if (path === '/command') result = await authority.command(body.caller, body.command);
      else if (path === '/observation') result = await authority.reportEvidence(body);
      else if (path === '/runtime-observation') result = await authority.runtimeObservation(body);
      else if (path === '/model-reservation') result = await authority.reserveModel(body);
      else if (path === '/settle-owned-model-call') result = await authority.settleOwnedModelCall(body);
      else if (path === '/drain') result = await authority.drain();
      else if (path === '/advance-once') result = await authority.advanceOnce();
      else if (path === '/set-evaluator-unavailable') result = await authority.setEvaluatorUnavailable(body);
      else if (path === '/set-evaluator-pending') result = await authority.setEvaluatorPending(body);
      else if (path === '/settle-owned-effects') result = await authority.settleOwnedEffects();
      else if (path === '/set-fake-attempt-absent') result = await authority.setFakeAttemptAbsent();
      else if (path === '/remove-archive-blob') result = await authority.removeArchiveBlob();
      else if (path === '/restore-archive-blob') result = await authority.restoreArchiveBlob();
      else if (path === '/remove-receipt-journal') result = await authority.removeReceiptJournal();
      else if (path === '/restore-receipt-journal') result = await authority.restoreReceiptJournal();
      else if (path === '/verify-cleanup-archive') result = await authority.verifyOwnedCleanupArchive();
      else if (path === '/complete-fake-effect') result = await authority.completeFakeEffect();
      else if (path === '/set-owned-signers') result = await authority.setOwnedSigners(body);
      else if (path === '/prepare-owned-enrollment') result = await authority.prepareOwnedEnrollment(body);
      else if (path === '/owned-enroll') result = await authority.enroll(body.caller, body.enrollment);
      else if (path === '/add-owned-candidate') result = await authority.addOwnedCandidate(body);
      else if (path === '/advance-owned-head') result = await authority.advanceOwnedHead(body);
      else if (path === '/put-owned-object') result = await authority.putOwnedObject(body);
      else if (path === '/remove-owned-object') result = await authority.removeOwnedObject(body);
      else if (path === '/bind-owned-submission') result = await authority.bindOwnedSubmission(body);
      else if (path === '/object-store-deadlines') result = await objectStoreDeadlineChecks(env.OBJECTS);
      else if (path === '/inspect') result = await authority.inspect();
      else if (path === '/export') result = await authority.export(body.caller as TrustedCaller, body.kind, body.publicationId);
      else return Response.json({ error: 'UNKNOWN_TEST_ROUTE' }, { status: 404 });
      return Response.json(result);
    } catch (error) { return Response.json({ error: String((error as Error).message) }, { status: 409 }); }
  },
};
