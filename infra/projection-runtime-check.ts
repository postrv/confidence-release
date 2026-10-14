// SPDX-License-Identifier: Apache-2.0
// Local workerd + real D1 integration. Queue delivery is explicitly simulated.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { canonicalize, digest, sha256 } from '../packages/protocol/src/index.ts';
import type { Scope } from '../packages/protocol/src/types.ts';

// Host types intentionally stay separate from Workers ambient bindings.
type Event = { id: string; scope: Scope; sequence: number; digest: string; kind: string; objectId: string; payload: unknown };
type Delivery = { id: string; acknowledgements: number; retries: { delaySeconds: number | null }[] };
type Snapshot = { inbox: { id: string; digest: string }[]; events: { project_key: string; sequence: number; event_id: string; kind: string; object_id: string; payload: string }[]; watermarks: { project_key: string; sequence: number }[] };
const scope: Scope = { schemaVersion: 1, tenantId: 'owned-test-tenant', projectId: 'projection-test', projectIncarnation: 'incarnation-one' };
const projectKey = (value: Scope) => `${value.tenantId}/${value.projectId}/${value.projectIncarnation}`;
async function event(id: string, sequence: number, eventScope = scope): Promise<Event> {
  const identity = { id, scope: eventScope, sequence, kind: 'OWNED_TEST_EVENT', objectId: `object-${sequence}`, payload: { value: sequence, source: 'synthetic-projection-test' } };
  return { ...identity, digest: await digest(identity) };
}
function ack(delivery: Delivery): void { assert.equal(delivery.acknowledgements, 1); assert.deepEqual(delivery.retries, []); }
function retry(delivery: Delivery, delaySeconds: number): void { assert.equal(delivery.acknowledgements, 0); assert.deepEqual(delivery.retries, [{ delaySeconds }]); }
function coherent(snapshot: Snapshot): void {
  assert.equal(snapshot.inbox.length, snapshot.events.length, 'No inbox-only or event-only partial write');
  for (const row of snapshot.events) assert.ok(snapshot.inbox.some(item => item.id === row.event_id));
  for (const watermark of snapshot.watermarks) {
    const sequences = snapshot.events.filter(row => row.project_key === watermark.project_key).map(row => row.sequence);
    assert.deepEqual(sequences, Array.from({ length: watermark.sequence }, (_, index) => index + 1), 'Events and watermark are contiguous and agree');
  }
  assert.equal(new Set(snapshot.events.map(row => row.project_key)).size, snapshot.watermarks.length);
}

const directory = await mkdtemp(join(tmpdir(), 'confidence-projector-workerd-')), bundleDirectory = join(directory, 'bundle'); await mkdir(bundleDirectory);
const reportPath = resolve(process.env.PROJECTION_RUNTIME_REPORT || 'demo-output/projection-runtime.json');
const run = promisify(execFile);
await run(resolve('node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--config', 'infra/test-projector/wrangler.jsonc', '--outdir', bundleDirectory], { cwd: resolve('.'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
const scripts = (await readdir(bundleDirectory)).filter(name => name.endsWith('.js')); assert.equal(scripts.length, 1);
const options = convertV4MiniflareOptions({ name: 'owned-projection-runtime', modulesRoot: bundleDirectory, modules: [{ type: 'ESModule', path: join(bundleDirectory, scripts[0]) }, ...(await readdir(bundleDirectory)).filter(name=>name.endsWith('.wasm')).map(name=>({type:'CompiledWasm' as const,path:join(bundleDirectory,name)}))], compatibilityDate: '2026-10-01', compatibilityFlags:['nodejs_compat'], durableObjects:{PROJECTS:{className:'ProjectionAuthority',useSQLite:true}}, serviceBindings:{AUTHORITY:'owned-projection-runtime'}, r2Buckets:{OBJECTS:'owned-test-only-projection-objects'}, bindings:{AUTH_TENANT_ID:'owned-test-tenant',MAINTENANCE_MODE:'false',PROJECTOR_SERVICE_TOKEN:'owned-projector-token-not-a-secret-0001',APP_SERVICE_TOKEN:'owned-app-token-not-a-secret-000000001',RUNNER_SERVICE_TOKEN:'owned-runner-token-not-a-secret-00001',EVALUATOR_SERVICE_TOKEN:'owned-evaluator-token-not-a-secret-01'}, d1Databases: { DB: 'owned-test-projection' }, resourcePersistencePath: join(directory, 'persist'), log: new Log(LogLevel.ERROR) });
let runtime = new Miniflare(options); const checks: string[] = [], observations: { check: string; deliveries: Delivery[]; snapshotDigest: string }[] = [];
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await runtime.dispatchFetch('http://owned.test' + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<T>;
}
const inspect = () => call<Snapshot>('/inspect');
const deliver = (events: Event[]) => call<Delivery[]>('/deliver', { events });
async function record(check: string, deliveries: Delivery[], snapshot: Snapshot): Promise<void> { coherent(snapshot); checks.push(check); observations.push({ check, deliveries, snapshotDigest: await digest(snapshot) }); }
const first = await event('first', 1), second = await event('second', 2), third = await event('third', 3), fourth = await event('concurrent-fourth', 4), fifth = await event('atomic-fifth', 5);
const migration = await readFile(resolve('migrations/0001_projection.sql'), 'utf8');
try {
  await runtime.ready;
  // D1 exec treats each line as SQL and rejects a comment-only line. Retain
  // the original migration hash and execute its unchanged SQL statements.
  await (await runtime.getD1Database('DB')).exec(migration.split('\n').filter(line => line.trim() && !line.trimStart().startsWith('--')).join('\n'));
  const initial = await inspect(); assert.deepEqual(initial, { inbox: [], events: [], watermarks: [] });
  let deliveries = await deliver([first]), state = await inspect(); ack(deliveries[0]);
  assert.deepEqual(state.inbox, [{ id: first.id, digest: first.digest }]);
  assert.deepEqual(state.events, [{ project_key: projectKey(scope), sequence: 1, event_id: first.id, kind: first.kind, object_id: first.objectId, payload: canonicalize(first.payload) }]);
  assert.deepEqual(state.watermarks, [{ project_key: projectKey(scope), sequence: 1 }]);
  await record('Actual migration and unchanged handler atomically project the first event, inbox digest, canonical payload, and watermark', deliveries, state);

  const firstSnapshot = structuredClone(state); deliveries = await deliver([first, first]); deliveries.forEach(ack); state = await inspect(); assert.deepEqual(state, firstSnapshot);
  await record('Identical duplicate deliveries acknowledge without adding events or advancing the watermark', deliveries, state);

  const staleDigest = { ...first, payload: { value: 999, source: 'altered-body' } };
  const { digest: _oldDigest, ...alteredIdentity } = staleDigest;
  const changedDigest = { ...alteredIdentity, digest: await digest(alteredIdentity) };
  const digestOnly = { ...first, digest: 'sha256:' + '9'.repeat(64) };
  deliveries = await deliver([staleDigest, changedDigest, digestOnly]); deliveries.forEach(delivery => retry(delivery, 10)); state = await inspect(); assert.deepEqual(state, firstSnapshot);
  await record('Duplicate identity with an altered body, recomputed conflicting digest, or invalid digest retries without mutation', deliveries, state);

  deliveries = await deliver([third]); retry(deliveries[0], 5); assert.deepEqual(await inspect(), firstSnapshot);
  const outOfOrder = await deliver([third, second]); retry(outOfOrder[0], 5); ack(outOfOrder[1]);
  state = await inspect(); assert.equal(state.watermarks[0].sequence, 2); assert.equal(state.events.length, 2);
  const catchup = await deliver([third]); ack(catchup[0]); state = await inspect(); assert.equal(state.watermarks[0].sequence, 3);
  await record('Gaps and out-of-order batches retry with delay five; predecessor delivery permits exact catchup without skipped events', [...deliveries, ...outOfOrder, ...catchup], state);

  deliveries = await call<Delivery[]>('/concurrent', { event: fourth, deliveries: 8 });
  assert.ok(deliveries.some(delivery => delivery.acknowledgements === 1));
  deliveries.forEach(delivery => delivery.acknowledgements === 1 ? ack(delivery) : retry(delivery, 10));
  state = await inspect(); assert.equal(state.events.filter(row => row.event_id === fourth.id).length, 1); assert.equal(state.watermarks[0].sequence, 4); assert.equal(state.inbox.length, 4);
  const concurrentSnapshot = structuredClone(state), duplicateRecovery = await deliver([fourth]); ack(duplicateRecovery[0]); assert.deepEqual(await inspect(), concurrentSnapshot);
  await record('Eight concurrent same-event handler invocations produce exactly one durable event; racing retries replay safely', [...deliveries, ...duplicateRecovery], state);

  // Inject a test-only failure in the FINAL statement, after inbox and event
  // INSERTs execute inside the unchanged production D1 batch. D1 must roll
  // back both earlier statements, rather than leaving a false receipt prefix.
  const faultSql = "CREATE TRIGGER owned_watermark_failure BEFORE UPDATE ON watermarks WHEN NEW.sequence=5 BEGIN SELECT RAISE(ABORT,'OWNED_WATERMARK_FAILURE'); END;";
  await (await runtime.getD1Database('DB')).exec(faultSql);
  deliveries = await deliver([fifth]); retry(deliveries[0], 10); assert.deepEqual(await inspect(), concurrentSnapshot);
  await (await runtime.getD1Database('DB')).exec('DROP TRIGGER owned_watermark_failure;');
  const afterFault = await deliver([fifth]); ack(afterFault[0]); state = await inspect(); assert.equal(state.inbox.length, 5); assert.equal(state.events.length, 5); assert.equal(state.watermarks[0].sequence, 5);
  await record('Failure in final watermark statement rolls back inbox and event inserts; removing owned fault permits one coherent retry', [...deliveries, ...afterFault], state);

  const separated = await Promise.all([
    event('new-incarnation-first', 1, { ...scope, projectIncarnation: 'incarnation-two' }),
    event('new-tenant-first', 1, { ...scope, tenantId: 'another-owned-tenant' }),
    event('new-project-first', 1, { ...scope, projectId: 'another-owned-project' }),
  ]);
  deliveries = await deliver(separated); deliveries.forEach(ack); state = await inspect();
  assert.equal(state.watermarks.length, 4); assert.equal(state.watermarks.find(row => row.project_key === projectKey(scope))!.sequence, 5);
  for (const item of separated) assert.equal(state.watermarks.find(row => row.project_key === projectKey(item.scope))!.sequence, 1);
  const scopedSnapshot = structuredClone(state), { digest: _firstDigest, ...firstIdentity } = first;
  const reusedAcrossScopeIdentity = { ...firstIdentity, scope: separated[0].scope };
  const scopeConflict = await deliver([{ ...reusedAcrossScopeIdentity, digest: await digest(reusedAcrossScopeIdentity) }]); retry(scopeConflict[0], 10); assert.deepEqual(await inspect(), scopedSnapshot);
  await record('Tenant, project, and incarnation streams maintain independent watermarks; globally reused event identity across scope is rejected', [...deliveries, ...scopeConflict], state);

  const conflictScope = { ...scope, projectId: 'owned-conflicting-sequence' };
  const competing = await Promise.all([event('competing-sequence-left', 1, conflictScope), event('competing-sequence-right', 1, conflictScope)]);
  deliveries = (await Promise.all(competing.map(item => deliver([item])))).flat();
  assert.equal(deliveries.filter(delivery => delivery.acknowledgements === 1).length, 1);
  const winner = deliveries.findIndex(delivery => delivery.acknowledgements === 1), loser = 1 - winner;
  ack(deliveries[winner]); assert.equal(deliveries[loser].acknowledgements, 0); assert.equal(deliveries[loser].retries.length, 1);
  assert.ok([5, 10].includes(deliveries[loser].retries[0].delaySeconds!));
  state = await inspect(); assert.equal(state.events.filter(row => row.project_key === projectKey(conflictScope)).length, 1);
  assert.equal(state.inbox.filter(row => row.id === competing[loser].id).length, 0);
  assert.equal(state.inbox.filter(row => row.id === competing[winner].id).length, 1);
  const competingSnapshot = structuredClone(state), loserRetry = await deliver([competing[loser]]); retry(loserRetry[0], 5); assert.deepEqual(await inspect(), competingSnapshot);
  await record('Concurrent distinct event IDs at one scope/sequence retain only one winner; losing inbox is absent and replay remains unacknowledged', [...deliveries, ...loserRetry], state);

  await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready; assert.deepEqual(await inspect(), competingSnapshot);
  deliveries = await deliver([first, third, fourth, fifth, ...separated, competing[winner]]); deliveries.forEach(ack); state = await inspect(); assert.deepEqual(state, competingSnapshot);
  await record('Fresh workerd instance retains actual D1 inbox/events/watermarks and safely acknowledges historical duplicates', deliveries, state);

  // Actual production history/replay paths, with explicitly trusted test seeding.
  const recoveryScope = {...scope,projectId:'owned-rebuild'};
  type Source = {failedEvent?:string;project:{revision:string;head:string;publicationSequence:string};originals:{event:Event;state:string}[];tasks:{id:string;payload:string;state:string}[];replays:{id:string;throughSequence:number;nextSequence:number}[];sent:Event[]};
  const fixture = <T>(path:string,body:unknown={})=>call<T>('/fixture/'+path,{scope:recoveryScope,...body as object});
  let source=await fixture<Source>('seed',{count:320,large:true});
  const frozenOriginals=source.originals.slice(),target=source.originals[319].event;
  const reference=source.originals[0].event.payload as {projection:string;payloadBytes:number};
  assert.equal(reference.projection,'AUTHORITY_EVENT_REFERENCE');assert(reference.payloadBytes>64000);
  assert(source.originals.every(item=>Buffer.byteLength(canonicalize(item.event))<=64*1024));
  const recoveryDeliver=(events:Event[])=>call<Delivery[]>('/deliver',{events,automatic:true});
  const historyBody={schemaVersion:1,scope:recoveryScope,afterSequence:0,throughSequence:319,target:{id:target.id,digest:target.digest,sequence:320}};
  const historyResponse=await runtime.dispatchFetch('http://owned.test/internal/projection/history',{method:'POST',headers:{authorization:'Bearer owned-projector-token-not-a-secret-0001','content-type':'application/json'},body:canonicalize(historyBody)});
  assert.equal(historyResponse.status,200,await historyResponse.clone().text());
  const serviceRequest=async(raw:string,token='owned-projector-token-not-a-secret-0001',path='/internal/projection/history',config?:string)=>{
    const response=await runtime.dispatchFetch('http://owned.test/fixture/service-request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path,raw,token,config})});return {status:response.status,body:await response.json() as any};
  };
  for(const token of ['', 'owned-wrong-token-not-a-secret-0000001','owned-app-token-not-a-secret-000000001','owned-runner-token-not-a-secret-00001','owned-evaluator-token-not-a-secret-01'])assert.equal((await serviceRequest(canonicalize({...historyBody,scope:{...recoveryScope,projectId:'absent-owned-project'}}),token)).status,401);
  for(const path of ['/internal/command','/internal/runner/observation','/internal/observation'])assert.equal((await serviceRequest('{}',undefined,path)).status,401);
  assert.equal((await serviceRequest(canonicalize(historyBody),undefined,undefined,'missing')).status,401);
  assert.equal((await serviceRequest(canonicalize(historyBody),'owned-app-token-not-a-secret-000000001',undefined,'alias')).status,503);
  assert.equal((await serviceRequest(canonicalize({...historyBody,scope:{...recoveryScope,projectIncarnation:'stale-owned-incarnation'}}))).status,409);
  assert.equal((await serviceRequest(canonicalize({...historyBody,scope:{...recoveryScope,tenantId:'another-owned-tenant'}}))).status,409);
  for(const raw of [canonicalize({...historyBody,extra:true}),'{"schemaVersion":1,'+canonicalize(historyBody).slice(1),canonicalize({...historyBody,afterSequence:-1}),canonicalize({...historyBody,throughSequence:318}),'x'.repeat(4097)])assert.notEqual((await serviceRequest(raw)).status,200);
  await fixture('corrupt',{id:target.id,kind:'digest'});
  assert.equal((await serviceRequest(canonicalize(historyBody))).status,409);
  await fixture('corrupt',{id:target.id,kind:'restore'});
  await fixture('corrupt',{id:source.originals[31].event.id,kind:'digest'});
  assert.equal((await serviceRequest(canonicalize(historyBody))).status,409);
  await fixture('corrupt',{id:source.originals[31].event.id,kind:'restore'});
  assert.equal((await serviceRequest(canonicalize(historyBody))).status,200);
  state=await inspect();
  await record('Narrow history service rejects missing/wrong/other-role or aliased capabilities before absent-project lookup, current-scope mismatch, duplicate/extra/oversized control JSON and corrupt retained target or predecessor',[],state);
  const beforeHostileHistory=structuredClone(state);deliveries=[];
  for(const historyMode of ['invalid-suffix','cross-scope','cursor','oversize','duplicate-json','wrong-token','missing','late-page']){
    const item=await call<Delivery[]>('/deliver',{events:[target],automatic:true,historyMode});retry(item[0],historyMode==='missing'?5:10);deliveries.push(...item);assert.deepEqual(await inspect(),beforeHostileHistory,'The entire history page must validate before any prefix write');
  }
  await new Promise(resolve=>setTimeout(resolve,200));assert.equal((await call<{completed:boolean}>('/fixture/late-page')).completed,true);assert.deepEqual(await inspect(),beforeHostileHistory,'Late uncancelled history completion must not mutate D1');
  await record('A valid history prefix followed by invalid suffix/scope/cursor, unbounded body, duplicate JSON or denied/missing capability or late uncancelled response cannot partially advance D1; original target remains unacknowledged',deliveries,state);
  const heavyScope={...recoveryScope,projectId:'owned-heavy-pages'};
  const heavy=await fixture<Source>('seed',{scope:heavyScope,count:4,payloadSize:60000});const heavyTarget=heavy.originals[3].event;
  const heavyRequest={...historyBody,scope:heavyScope,throughSequence:3,target:{id:heavyTarget.id,digest:heavyTarget.digest,sequence:4}};
  const heavyResponse=await serviceRequest(canonicalize(heavyRequest));assert.equal(heavyResponse.status,200);assert.equal(heavyResponse.body.events.length,2);assert.equal(heavyResponse.body.nextSequence,2);assert.equal(heavyResponse.body.complete,false);assert(Buffer.byteLength(canonicalize(heavyResponse.body))<=128*1024);
  const heavyTail=await serviceRequest(canonicalize({...heavyRequest,afterSequence:2}));assert.equal(heavyTail.status,200);assert.equal(heavyTail.body.events.length,1);assert.equal(heavyTail.body.nextSequence,3);assert.equal(heavyTail.body.complete,true);assert(Buffer.byteLength(canonicalize(heavyTail.body))<=128*1024);
  await record('Near64KiB individual events reduce a history page below32 rows to honor the128KiB aggregate cap and expose an exact resumable cursor',[],state);
  deliveries=[];
  for(let i=0;i<10;i++){const item=await recoveryDeliver([target]);deliveries.push(...item);if(item[0].acknowledgements)break;retry(item[0],5);}
  assert.equal(deliveries.at(-1)!.acknowledgements,1);state=await inspect();
  assert.equal(state.watermarks.find(row=>row.project_key===projectKey(recoveryScope))!.sequence,320);
  assert.equal(state.events.filter(row=>row.project_key===projectKey(recoveryScope)).length,320);
  await record('A gap automatically fetches original authority history beyond256 events in bounded32-event pages and converges through actual D1; large payload remains an explicit strong reference',deliveries,state);

  const caller={principal:{id:'owned-human',tenantId:scope.tenantId,credentialClass:'human'},projectId:recoveryScope.projectId};
  const command=(commandId:string,body:unknown,revision=source.project.revision)=>({caller,command:{commandId,expectedRevision:revision,operation:'replay-projection',body}});
  const firstBody={scope:recoveryScope,afterSequence:0,throughSequence:null,replayId:null};
  const firstRequest=command('replay-first',firstBody);
  const postCommand=async(request:unknown)=>{const response=await runtime.dispatchFetch('http://owned.test/fixture/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope:recoveryScope,...request as object})});return {status:response.status,body:await response.json() as any};};
  let firstReplay=await postCommand(firstRequest);assert.equal(firstReplay.status,202);assert.equal(firstReplay.body.delivery,'QUEUED');assert.equal(firstReplay.body.throughSequence,320);assert.equal(firstReplay.body.nextSequence,32);
  const concurrentDuplicates=await Promise.all([postCommand(firstRequest),postCommand(firstRequest)]);assert(concurrentDuplicates.every(result=>result.status===202&&canonicalize(result.body)===canonicalize(firstReplay.body)));
  source=await fixture<Source>('inspect');assert.equal(source.tasks.length,32);assert.equal(source.project.head,'a'.repeat(40));assert.equal(source.project.publicationSequence,'0');
  assert.equal((await postCommand(command('replay-first',{...firstBody,throughSequence:319},'1'))).status,409);
  await runtime.dispose();runtime=new Miniflare(options);await runtime.ready;
  source=await fixture<Source>('inspect');assert.equal(source.tasks.length,32);
  assert.equal((await postCommand(firstRequest)).status,202);
  await fixture('member',{subject:'owned-human',roles:['reader'],active:true});
  assert.equal((await postCommand(firstRequest)).status,403);
  await fixture('member',{subject:'owned-human',roles:['admin','reader'],active:true});
  const cursor={scope:recoveryScope,replayId:firstReplay.body.replayId,afterSequence:32,throughSequence:320};
  source=await fixture<Source>('inspect');
  const racers=await Promise.all([postCommand(command('race-left',cursor)),postCommand(command('race-right',cursor))]);
  assert.deepEqual(racers.map(item=>item.status).sort(),[202,409]);
  let replay=racers.find(item=>item.status===202)!.body;
  source=await fixture<Source>('inspect');assert.equal(source.tasks.length,64);
  assert.equal((await postCommand(command('stale-cursor',cursor))).status,409);
  while(!replay.complete){source=await fixture<Source>('inspect');const next=await postCommand(command('page-'+replay.nextSequence,{...cursor,afterSequence:replay.nextSequence}));assert.equal(next.status,202);replay=next.body;}
  source=await fixture<Source>('inspect');assert.equal(source.tasks.length,320);assert(source.tasks.every((row,index)=>canonicalize(JSON.parse(row.payload))===canonicalize(frozenOriginals[index].event)));
  assert.deepEqual(source.originals.slice(0,320),frozenOriginals);assert.equal(source.replays[0].throughSequence,320);
  await record('Human-admin replay freezes320 originals; duplicate/restarted commands, changed intent, revoked admin and racing/stale pages preserve one durable exact-event task per cursor without canonical changes',[],state);

  // Erase this owned non-authoritative D1 projection to model empty-view restoration.
  const database=await runtime.getD1Database('DB'); await database.batch(['DELETE FROM watermarks','DELETE FROM events','DELETE FROM inbox'].map(sql=>database.prepare(sql)));
  assert.deepEqual(await inspect(),{inbox:[],events:[],watermarks:[]});
  source=await fixture<Source>('pump',{fail:true});
  for(let i=0;i<60&&source.tasks.some(row=>row.state==='PENDING');i++)source=await fixture<Source>('pump');
  assert(source.tasks.every(row=>row.state==='DELIVERED'));assert(source.sent.length>=321);
  const frozenIds=new Set(frozenOriginals.map(item=>item.event.id));const replayed=source.sent.filter(event=>frozenIds.has(event.id));
  deliveries=[];for(let i=0;i<replayed.length;i+=32){const batch=await deliver(replayed.slice(i,i+32));batch.forEach(ack);deliveries.push(...batch);}
  state=await inspect();assert.equal(state.watermarks.find(row=>row.project_key===projectKey(recoveryScope))!.sequence,320);
  assert.equal(state.events.filter(row=>row.project_key===projectKey(recoveryScope)).length,state.watermarks[0].sequence);
  assert(source.failedEvent&&frozenIds.has(source.failedEvent));assert.equal(source.sent.filter(event=>event.id===source.failedEvent).length,2);
  await record('Actual replay outbox loses one send response, safely duplicates its original identity and restores an empty D1 prefix without assuming Queue acknowledgment means D1 confirmation',deliveries,state);

  const testedInputs = Object.fromEntries(await Promise.all(['workers/projector/index.ts', 'migrations/0001_projection.sql', 'packages/protocol/src/index.ts', 'infra/test-projector/worker.ts','workers/authority/index.ts','workers/authority/schema.ts','workers/shared/projection.ts','workers/authority/types.ts','infra/projection-runtime-check.ts','infra/test-projector/wrangler.jsonc'].map(async path => [path, await sha256(await readFile(resolve(path)))])));
  const versions = Object.fromEntries(await Promise.all(['miniflare', 'workerd', 'wrangler'].map(async name => [name, JSON.parse(await readFile(resolve(`node_modules/${name}/package.json`), 'utf8')).version])));
  const report = Buffer.from(JSON.stringify({ schemaVersion: 1, status: 'PASS', runtime: 'Actual local Miniflare/workerd and persistent D1; Queue MessageBatch delivery simulated', compatibilityDate: '2026-10-01', versions, testedInputs, bundledWorkerDigest: await sha256(await readFile(join(bundleDirectory, scripts[0]))), checks, observations, events: [first, second, third, fourth, fifth, ...separated, ...competing], finalSnapshot: state, finalSnapshotDigest: await digest(state), limitations: ['The unchanged production queue handler runs against actual local D1 with the exact migration SQL statements; comment-only lines are omitted for D1 exec. Queue delivery, ack and retry callbacks are owned test objects.', 'No remote Cloudflare Queue, delivery schedule, retry timing, dead-letter behavior or deployment claim is made.', 'Owned test seeding creates synthetic authority events; the actual production history, human-admin replay command, outbox dispatcher and D1 handler run unchanged. No repository, OIDC, publication or remote Queue producer result is claimed.', 'One owned test-only trigger forces a final-statement SQL failure to verify batch rollback; it is removed before persistence/replay checks.'] }, null, 2));
  assert.ok(report.length <= 512 * 1024, 'Owned runtime report exceeds its 512 KiB bound'); await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, report);
  process.stdout.write(JSON.stringify({ status: 'PASS', checks: checks.length, retainedEvents: state.events.length, scopes: state.watermarks.length, report: reportPath, queueDelivery: 'simulated-local-D1' }) + '\n');
} finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
