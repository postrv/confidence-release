// SPDX-License-Identifier: Apache-2.0
// Separately deployable finite probe. The production projector is unchanged.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import projector from '../../workers/projector/index';
import { canonicalize } from '../../packages/protocol/src/index';
import { errorResponse, readBounded, requireValue } from '../../workers/shared/errors';
import { historyRequest, type ProjectionHistoryPage } from '../../workers/shared/projection';
import type { ProjectionEvent } from '../../workers/authority/types';
import { originalEvents, ownedScope, stages, type Stage } from './fixture';

interface Env { DB:D1Database; EVENTS:Queue<ProjectionEvent>; RUN_ID:string; RUN_EXPIRES_AT:string; SOURCE_SET_DIGEST:string; WORKER_NAME:string; QUEUE_NAME:string; DATABASE_ID:string; CONTROL_TOKEN:string; PROJECTOR_SERVICE_TOKEN:string }
const encode=new TextEncoder();
function validEnvironment(env:Env):void {
  requireValue(/^[a-f0-9-]{36}$/.test(env.RUN_ID)&&env.WORKER_NAME===`confidence-projection-${env.RUN_ID.replaceAll('-','').slice(0,20)}`&&env.QUEUE_NAME===env.WORKER_NAME+'-events'&&/^[a-f0-9-]{36}$/.test(env.DATABASE_ID)&&/^sha256:[a-f0-9]{64}$/.test(env.SOURCE_SET_DIGEST),'OWNED_ASSOCIATION_REQUIRED',503);
  const expiry=Number(env.RUN_EXPIRES_AT);requireValue(Number.isSafeInteger(expiry)&&expiry>Date.now()&&expiry<=Date.now()+30*60_000,'PROBE_EXPIRED',410);
  requireValue(typeof env.CONTROL_TOKEN==='string'&&env.CONTROL_TOKEN.length>=32&&env.CONTROL_TOKEN.length<=128&&typeof env.PROJECTOR_SERVICE_TOKEN==='string'&&env.PROJECTOR_SERVICE_TOKEN.length>=32&&env.PROJECTOR_SERVICE_TOKEN.length<=128&&env.CONTROL_TOKEN!==env.PROJECTOR_SERVICE_TOKEN,'PRIVATE_CAPABILITIES_REQUIRED',503);
}
function authentic(request:Request,token:string):boolean {const a=encode.encode(request.headers.get('authorization')??''),b=encode.encode('Bearer '+token);return a.length===b.length&&timingSafeEqual(a,b);}
async function state(env:Env) {return (await env.DB.prepare('SELECT history_enabled,consumer_gate FROM probe_state WHERE singleton=1').first<{history_enabled:number;consumer_gate:string}>())!;}
async function snapshot(env:Env) {
  const rows=await env.DB.batch<Record<string,unknown>>([
    env.DB.prepare('SELECT id,digest FROM inbox ORDER BY id'),env.DB.prepare('SELECT project_key,sequence,event_id,kind,object_id,payload FROM events ORDER BY project_key,sequence'),env.DB.prepare('SELECT project_key,sequence FROM watermarks ORDER BY project_key'),
    env.DB.prepare('SELECT stage,state,dispatches,started_at,result FROM probe_controls ORDER BY started_at,stage'),env.DB.prepare('SELECT * FROM probe_deliveries ORDER BY observed_at,message_id,attempt LIMIT 128'),env.DB.prepare("SELECT id,state,started_at FROM probe_invocations WHERE state='ACTIVE'"),
  ]);
  const result={schemaVersion:1,runId:env.RUN_ID,sourceSetDigest:env.SOURCE_SET_DIGEST,workerName:env.WORKER_NAME,queueName:env.QUEUE_NAME,databaseId:env.DATABASE_ID,scope:ownedScope(env.RUN_ID),historyProvider:'owned-synthetic-five-event-fixture',consumer:await state(env),inbox:rows[0].results,events:rows[1].results,watermarks:rows[2].results,controls:rows[3].results,deliveries:rows[4].results,activeInvocations:rows[5].results};
  requireValue(encode.encode(canonicalize(result)).length<=64*1024,'PROBE_REPORT_LIMIT',413);return result;
}
/** Actual loopback Service Binding, with an intentionally synthetic provider. */
export class FixtureHistory extends WorkerEntrypoint<Env> {
  async fetch(request:Request):Promise<Response> {
    try {
      validEnvironment(this.env);requireValue(authentic(request,this.env.PROJECTOR_SERVICE_TOKEN),'AUTHENTICATION_FAILED',401);
      const url=new URL(request.url);requireValue(url.pathname==='/internal/projection/history'&&!url.search&&request.method==='POST','FIXED_HISTORY_ROUTE',405);
      const raw=new TextDecoder('utf-8',{fatal:true}).decode(await readBounded(request.body,4096));const body:unknown=JSON.parse(raw);requireValue(canonicalize(body)===raw,'STRICT_CANONICAL_JSON');historyRequest(body);
      requireValue(canonicalize(body.scope)===canonicalize(ownedScope(this.env.RUN_ID)),'OWNED_HISTORY_SCOPE',409);
      const originals=await originalEvents(this.env.RUN_ID),target=originals.find(event=>event.id===body.target.id);
      requireValue(target&&target.digest===body.target.digest&&target.sequence===body.target.sequence,'OWNED_HISTORY_TARGET',409);
      requireValue((await state(this.env)).history_enabled===1,'OWNED_HISTORY_TEMPORARILY_WITHHELD',503);
      const events=originals.filter(event=>event.sequence>body.afterSequence&&event.sequence<=body.throughSequence),nextSequence=events.at(-1)?.sequence??body.afterSequence;
      const page:ProjectionHistoryPage={...body,events,nextSequence,complete:nextSequence===body.throughSequence};validEnvironment(this.env);return new Response(canonicalize(page),{headers:{'content-type':'application/json','cache-control':'no-store'}});
    }catch(error){return errorResponse(error);}
  }
}
async function control(stage:Stage,env:Env) {
  const prior=await env.DB.prepare('SELECT state,result FROM probe_controls WHERE stage=?').bind(stage).first<{state:string;result:string|null}>();
  if(prior){requireValue(prior.state==='ACKNOWLEDGED'&&prior.result,'CONTROL_EFFECT_UNRESOLVED',409);return JSON.parse(prior.result!);}
  const needed=stage==='first'?null:stages[stages.indexOf(stage)-1];
  if(needed)requireValue((await env.DB.prepare('SELECT state FROM probe_controls WHERE stage=?').bind(needed).first<{state:string}>())?.state==='ACKNOWLEDGED','FIXED_STAGE_ORDER',409);
  const reserved=await env.DB.prepare("INSERT OR IGNORE INTO probe_controls(stage,state,dispatches,started_at) VALUES(?,'MAY_HAVE_DISPATCHED',1,?)").bind(stage,Date.now()).run();
  requireValue(reserved.meta.changes===1,'CONTROL_EFFECT_UNRESOLVED',409);
  const originals=await originalEvents(env.RUN_ID);let result:Record<string,unknown>={stage,dispatches:1};
  if(stage==='first'||stage==='gap') {validEnvironment(env);await env.EVENTS.send(originals[stage==='first'?0:4]);result={...result,delivery:'QUEUED',eventIds:[originals[stage==='first'?0:4].id]};}
  if(stage==='recover') {requireValue((await env.DB.prepare("SELECT COUNT(*) AS total FROM probe_deliveries WHERE event_id=? AND action='RETRY_REQUESTED'").bind(originals[4].id).first<{total:number}>())!.total>0,'NATIVE_RETRY_UNOBSERVED',409);await env.DB.prepare('UPDATE probe_state SET history_enabled=1 WHERE singleton=1').run();result={...result,historyEnabled:true};}
  if(stage==='duplicates') {validEnvironment(env);await env.EVENTS.sendBatch([originals[0],originals[2],originals[2]].map(body=>({body})));result={...result,delivery:'QUEUED',eventIds:[originals[0].id,originals[2].id,originals[2].id]};}
  if(stage==='empty') {
    // One SQL guard closes admission against any concurrent native callback.
    const closed=await env.DB.prepare("UPDATE probe_state SET consumer_gate='CLOSED' WHERE singleton=1 AND consumer_gate='OPEN' AND NOT EXISTS(SELECT 1 FROM probe_invocations WHERE state='ACTIVE')").run();
    requireValue(closed.meta.changes===1,'ACTIVE_CONSUMER_FENCE',409);
    const metrics=await env.EVENTS.metrics();requireValue(metrics.backlogCount===0&&metrics.backlogBytes===0,'QUEUE_DRAIN_UNOBSERVED',409);
    const before=await snapshot(env);requireValue(before.activeInvocations.length===0&&before.inbox.length===5&&before.events.length===5&&before.watermarks.length===1,'OWNED_VIEW_NOT_COMPLETE',409);
    const expected=new Map(originals.map(event=>[event.id,event]));const scope=ownedScope(env.RUN_ID),key=`${scope.tenantId}/${scope.projectId}/${scope.projectIncarnation}`;requireValue(before.inbox.every(row=>expected.get(String(row.id))?.digest===row.digest)&&before.events.every(row=>{const original=expected.get(String(row.event_id));return original&&row.project_key===key&&row.sequence===original.sequence&&row.kind===original.kind&&row.object_id===original.objectId&&row.payload===canonicalize(original.payload);})&&before.watermarks[0].project_key===key&&before.watermarks[0].sequence===5&&before.controls.every(row=>row.stage==='empty'||row.state==='ACKNOWLEDGED'),'UNEXPECTED_OWNED_STATE',409);
    validEnvironment(env);await env.DB.batch(['DELETE FROM watermarks','DELETE FROM events','DELETE FROM inbox'].map(sql=>env.DB.prepare(sql)));
    result={...result,view:'EMPTY',consumerGate:'CLOSED',activeNativeInvocations:0,queueMetrics:{backlogCount:metrics.backlogCount,backlogBytes:metrics.backlogBytes},limitation:'Native backlog observation plus logical admission fencing cannot prevent future provider redelivery; a closed-gate callback cannot write the view.'};
  }
  if(stage==='rebuild') {requireValue((await state(env)).consumer_gate==='CLOSED','ERASE_FENCE_REQUIRED',409);await env.DB.prepare("UPDATE probe_state SET consumer_gate='OPEN' WHERE singleton=1 AND consumer_gate='CLOSED'").run();validEnvironment(env);await env.EVENTS.sendBatch([originals[4],originals[0]].map(body=>({body})));result={...result,delivery:'QUEUED',eventIds:[originals[4].id,originals[0].id],identities:'UNCHANGED_ORIGINALS'};}
  const encoded=canonicalize(result);await env.DB.prepare("UPDATE probe_controls SET state='ACKNOWLEDGED',result=? WHERE stage=? AND state='MAY_HAVE_DISPATCHED'").bind(encoded,stage).run();return result;
}
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    try {
      validEnvironment(env);requireValue(authentic(request,env.CONTROL_TOKEN),'AUTHENTICATION_FAILED',401);
      requireValue(!request.headers.has('origin')&&!new URL(request.url).search&&request.headers.get('x-owned-source-set')===env.SOURCE_SET_DIGEST,'OWNED_CONTROL_REQUIRED',403);
      const path=new URL(request.url).pathname;
      if(path==='/inspect'&&request.method==='GET')return Response.json(await snapshot(env),{headers:{'cache-control':'no-store'}});
      if(path==='/metrics'&&request.method==='GET')return Response.json(await env.EVENTS.metrics(),{headers:{'cache-control':'no-store'}});
      const stage=path.slice('/control/'.length);requireValue(request.method==='POST'&&path.startsWith('/control/')&&stages.includes(stage as Stage),'FIXED_CONTROL_ROUTE',405);requireValue((await readBounded(request.body,0)).length===0,'EMPTY_CONTROL_BODY');
      return Response.json(await control(stage as Stage,env),{headers:{'cache-control':'no-store'}});
    }catch(error){return errorResponse(error);}
  },
  async queue(batch:MessageBatch<ProjectionEvent>,env:Env,ctx:ExecutionContext):Promise<void> {
    validEnvironment(env);requireValue(batch.queue===env.QUEUE_NAME&&batch.messages.length<=32,'OWNED_QUEUE_REQUIRED');
    const originals=await originalEvents(env.RUN_ID);for(const message of batch.messages)requireValue(originals.some(event=>canonicalize(event)===canonicalize(message.body)),'FIXED_ORIGINAL_REQUIRED');
    const invocation=crypto.randomUUID(),entered=await env.DB.prepare("INSERT INTO probe_invocations(id,state,started_at) SELECT ?,'ACTIVE',? WHERE (SELECT consumer_gate FROM probe_state WHERE singleton=1)='OPEN'").bind(invocation,Date.now()).run();
    if(entered.meta.changes!==1){batch.retryAll({delaySeconds:10});return;}
    try {
      const outcomes:{message:Message<ProjectionEvent>;action:string;delay:number|null}[]=[];
      const messages=batch.messages.map(message=>({id:message.id,timestamp:message.timestamp,attempts:message.attempts,body:message.body,ack(){outcomes.push({message,action:'ACK_REQUESTED',delay:null});message.ack();},retry(options?:QueueRetryOptions){outcomes.push({message,action:'RETRY_REQUESTED',delay:options?.delaySeconds??null});message.retry(options);}}));
      const delegated:MessageBatch<ProjectionEvent>={queue:batch.queue,metadata:batch.metadata,messages,ackAll(){for(const message of messages)message.ack();},retryAll(options?:QueueRetryOptions){for(const message of messages)message.retry(options);}};
      const exports=ctx.exports as unknown as {FixtureHistory:Fetcher};
      await projector.queue(delegated,{DB:env.DB,AUTHORITY:exports.FixtureHistory,PROJECTOR_SERVICE_TOKEN:env.PROJECTOR_SERVICE_TOKEN});
      requireValue(outcomes.length===messages.length&&new Set(outcomes.map(outcome=>outcome.message.id)).size===messages.length,'NATIVE_CALLBACK_COUNT');
      const count=await env.DB.prepare('SELECT COUNT(*) AS total FROM probe_deliveries').first<{total:number}>();requireValue((count?.total??0)+outcomes.length<=128,'NATIVE_TELEMETRY_LIMIT',413);
      await env.DB.batch(outcomes.map(({message,action,delay})=>env.DB.prepare('INSERT OR IGNORE INTO probe_deliveries VALUES(?,?,?,?,?,?,?,?,?)').bind(message.id,message.attempts,message.body.id,message.body.digest,batch.queue,message.timestamp.getTime(),action,delay,Date.now())));
    }finally {await env.DB.prepare("UPDATE probe_invocations SET state='STOPPED' WHERE id=?").bind(invocation).run();}
  },
} satisfies ExportedHandler<Env,ProjectionEvent>;
