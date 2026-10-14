// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readdir,readFile,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Miniflare,Log,LogLevel,convertV4MiniflareOptions } from 'miniflare';
import type { Journal, Resource, Snapshot } from './types';
import { originalEvents,ownedScope } from './fixture';
import { canonicalize,sha256 } from '../../packages/protocol/src/index';
import { deployedWorkerMatches } from '../live-container/continuation';
import { accountGate,ownedConsumer,ownedProducer,ownedQueueAssociations,ownedApiResult,ownedResourceResult,reserveWorkerDeployment,exactView,observeApiTransport,type ApiTransportObservation } from '../live-projection-check';

test('scope gate requires selected OAuth with all three existing scopes',()=>{
 const raw={loggedIn:true,authType:'OAuth Token',accounts:[{id:'1'.repeat(32)}],tokenPermissions:['workers:write','queues:write','d1:write']};
 assert(accountGate(JSON.stringify(raw),'1'.repeat(32)));assert(!accountGate(JSON.stringify(raw),'2'.repeat(32)));
 for(const missing of raw.tokenPermissions)assert(!accountGate(JSON.stringify({...raw,tokenPermissions:raw.tokenPermissions.filter(value=>value!==missing)}),'1'.repeat(32)));
 assert(!accountGate(JSON.stringify({...raw,authType:'API Token'}),'1'.repeat(32)));
});
test('native consumer aliases must name one exact owned worker and never a pull consumer',()=>{
 assert(ownedConsumer({type:'worker',script:'owned-worker'},'owned-worker'));assert(ownedConsumer({type:'worker',script_name:'owned-worker'},'owned-worker'));
 assert(ownedConsumer({type:'worker',script:'owned-worker',script_name:'owned-worker'},'owned-worker'));
 for(const value of [{type:'worker',script:'owned-worker',script_name:'other-worker'},{type:'worker',service:'other-worker'},{type:'http_pull',script_name:'owned-worker'},{type:'worker'}])assert(!ownedConsumer(value,'owned-worker'));
 assert(ownedProducer({type:'worker',service:'owned-worker'},'owned-worker'));
 assert(ownedQueueAssociations({consumers:[],producers:[{type:'worker',script_name:'owned-worker'}]},'owned-worker'));
 for(const value of [{consumers:[]},{producers:[]},{consumers:null,producers:[]},{consumers:[],producers:[{type:'r2_bucket',bucket_name:'foreign'}]},{consumers:[],producers:[{type:'worker',script:'owned-worker',service:'foreign'}]},{consumers:[],producers:[{}]},{consumers:[{type:'http_pull'}],producers:[]}])assert(!ownedQueueAssociations(value,'owned-worker'));
});
test('only resource-classified provider absence permits cleanup and saved IDs cannot change names',async()=>{
 for(const errors of [undefined,null,[]])assert.deepEqual(ownedApiResult('/queues?name=owned',200,{success:true,result:[],...(errors===undefined?{}:{errors})}),{absent:false,result:[]});
 for(const errors of [[{code:10000}],{},'invalid',false,0])assert.throws(()=>ownedApiResult('/queues?name=owned',200,{success:true,result:[],errors}),/OWNED_API_UNAVAILABLE/);
 const id='11111111-1111-4111-8111-111111111111',queue='1'.repeat(32);
 for(const [path,code] of [['/workers/scripts/owned-worker/settings',10007],['/queues/'+queue,11000],['/d1/database/'+id,7404]] as const){
  const missing={success:false,result:null,errors:[{code}]};assert.deepEqual(ownedApiResult(path,404,missing),{absent:true,result:null});
  for(const body of [{...missing,errors:[{code:10000}]},{...missing,errors:[{code:7404}]},{...missing,errors:[]},{...missing,errors:null},{...missing,errors:undefined},{...missing,result:{}},{...missing,success:true}])if(body.errors?.[0]?.code!==code||body.success!==false||body.result!==null)assert.throws(()=>ownedApiResult(path,404,body),/OWNED_API_UNAVAILABLE/);
  assert.throws(()=>ownedApiResult(path,404,missing,'DELETE'),/OWNED_API_UNAVAILABLE/);
 }
 assert.throws(()=>ownedApiResult('/queues?name=owned',404,{success:false,result:null,errors:[{code:11000}]}),/OWNED_API_UNAVAILABLE/);
 const resource=(name:string,id:string|null):Resource=>({name,id,create:'ACKNOWLEDGED',remove:'NOT_DISPATCHED',absenceObservedAt:new Date().toISOString()});
 for(const kind of ['database','queue','deadLetter'] as const){const key=kind==='database'?'uuid':'queue_id',nameKey=kind==='database'?'name':'queue_name',saved=kind==='database'?id:queue;
  assert.equal(ownedResourceResult(kind,resource('owned',saved),{absent:false,result:{[key]:saved,[nameKey]:'owned'}})?.id,saved);
  assert.throws(()=>ownedResourceResult(kind,resource('owned',saved),{absent:false,result:{[key]:saved,[nameKey]:'foreign'}}),/OWNED_RESOURCE_MISMATCH/);
  assert.throws(()=>ownedResourceResult(kind,resource('owned',saved),{absent:false,result:{[key]:kind==='database'?'22222222-2222-4222-8222-222222222222':'2'.repeat(32),[nameKey]:'owned'}}),/OWNED_RESOURCE_MISMATCH/);
  assert.equal(ownedResourceResult(kind,resource('owned',saved),{absent:true,result:null}),null);
  assert.equal(ownedResourceResult(kind,resource('owned',null),{absent:false,result:[]}),null);
 }
 const observations:ApiTransportObservation[]=[],secret='FAKE_PRIVATE_TRANSPORT_MESSAGE_DO_NOT_RETAIN',path='/queues?name=owned';
 const successBody=JSON.stringify({success:true,errors:null,result:[],privateDetail:secret});
 assert.deepEqual(await observeApiTransport(path,'GET',observations,async signal=>{assert(signal instanceof AbortSignal);return new Response(successBody,{headers:{'x-private':secret}});}),{absent:false,result:[]});
 assert.equal(observations[0].timeoutMs,15000);assert.equal(observations[0].status,200);assert.equal(observations[0].bodyDigest,await sha256(successBody));assert.equal(observations[0].errorClass,null);
 const errorBody=JSON.stringify({success:false,result:null,errors:[{code:10000,message:secret},{code:10000,message:secret},{code:'not-numeric',message:secret}]});
 await assert.rejects(observeApiTransport(path,'POST',observations,async()=>new Response(errorBody,{status:403,headers:{'x-private':secret}})),/OWNED_API_UNAVAILABLE/);
 assert.equal(observations[1].timeoutMs,60000);assert.deepEqual(observations[1].numericErrorCodes,[10000]);assert.equal(observations[1].bodyDigest,await sha256(errorBody));assert.equal(observations[1].errorClass,'Error');
 const malformed='{'+secret;
 await assert.rejects(observeApiTransport(path,'GET',observations,async()=>new Response(malformed,{status:502})),SyntaxError);
 assert.equal(observations[2].bodyDigest,await sha256(malformed));assert.equal(observations[2].status,502);assert.equal(observations[2].errorClass,'SyntaxError');
 for(const name of ['TimeoutError','TypeError','PrivateNonWhitelistedClass']){
  const thrown=new Error(secret);thrown.name=name;
  await assert.rejects(observeApiTransport(path,'POST',observations,async()=>{throw thrown;}));
  const retained=observations.at(-1)!;assert.equal(retained.errorClass,name==='PrivateNonWhitelistedClass'?'Error':name);assert.equal(retained.status,null);assert.equal(retained.bodyDigest,null);
 }
 const keys=['bodyDigest','elapsedMs','errorClass','finishedAt','method','numericErrorCodes','path','startedAt','status','timeoutMs'].sort();
 for(const retained of observations){assert.deepEqual(Object.keys(retained).sort(),keys);assert.equal(typeof retained.finishedAt,'string');assert(Number.isSafeInteger(retained.elapsedMs));}
 const encoded=JSON.stringify(observations);assert(!encoded.includes(secret));assert(!encoded.includes('x-private'));assert(!encoded.includes('privateDetail'));assert(!encoded.includes('PrivateNonWhitelistedClass'));
});
test('deployment cannot overwrite an existing Worker or dispatch before its prior absence is durable',async()=>{
 const source=new TextEncoder().encode('export default { fetch() { return new Response(\"owned\"); } };');
 assert(await deployedWorkerMatches(new Response(source,{headers:{'content-type':'application/javascript'}}),source));
 assert(!await deployedWorkerMatches(new Response('{\"success\":false}',{status:405,headers:{'content-type':'application/json'}}),source));
 assert(!await deployedWorkerMatches(new Response(new TextEncoder().encode('changed'),{headers:{'content-type':'application/javascript'}}),source));
 const multipart=()=>{const form=new FormData();form.set('worker.js',new File([source],'worker.js',{type:'application/javascript'}));form.set('worker.js.map',new File(['{}'],'worker.js.map',{type:'application/json'}));return form;};
 assert(await deployedWorkerMatches(new Response(multipart(),{headers:{'cf-entrypoint':'worker.js'}}),source));
 assert(!await deployedWorkerMatches(new Response(multipart(),{headers:{'cf-entrypoint':'foreign.js'}}),source));
 const unexpected=multipart();unexpected.set('foreign.js',new File(['foreign'],'foreign.js'));assert(!await deployedWorkerMatches(new Response(unexpected,{headers:{'cf-entrypoint':'worker.js'}}),source));
 const journal={deploy:'NOT_DISPATCHED',workerAbsenceObservedAt:null} as Journal;let dispatches=0,persisted=false;
 const deploy=async(lookup:()=>Promise<{absent:boolean}>,persist:()=>Promise<void>)=>{await reserveWorkerDeployment(journal,lookup,persist);assert(persisted);dispatches++;};
 await assert.rejects(deploy(async()=>({absent:false}),async()=>{persisted=true;}),/OWNED_NAME_NOT_FRESH/);assert.equal(dispatches,0);assert.equal(journal.deploy,'NOT_DISPATCHED');assert.equal(journal.workerAbsenceObservedAt,null);
 await assert.rejects(deploy(async()=>{throw Error('OWNED_API_UNAVAILABLE');},async()=>{persisted=true;}),/OWNED_API_UNAVAILABLE/);assert.equal(dispatches,0);
 await assert.rejects(deploy(async()=>({absent:true}),async()=>{throw Error('DURABLE_WRITE_FAILED');}),/DURABLE_WRITE_FAILED/);assert.equal(dispatches,0);assert.equal(journal.deploy,'MAY_HAVE_DISPATCHED');
 await assert.rejects(deploy(async()=>({absent:true}),async()=>{persisted=true;}),/RECONCILE_BEFORE_RETRY/);assert.equal(dispatches,0);
 journal.deploy='NOT_DISPATCHED';await deploy(async()=>({absent:true}),async()=>{assert.equal(journal.deploy,'MAY_HAVE_DISPATCHED');assert(Number.isFinite(Date.parse(journal.workerAbsenceObservedAt!)));persisted=true;});assert.equal(dispatches,1);
});
test('projection proof rejects changed rows even when inbox and watermark appear complete',async()=>{
 const runId='11111111-1111-4111-8111-111111111111',originals=await originalEvents(runId),scope=ownedScope(runId),key=`${scope.tenantId}/${scope.projectId}/${scope.projectIncarnation}`;
 const view=(through:number):Snapshot=>({schemaVersion:1,runId,scope,sourceSetDigest:'sha256:'+'1'.repeat(64),workerName:'owned-worker',queueName:'owned-events',databaseId:runId,consumer:{consumer_gate:'OPEN',history_enabled:1},controls:[],deliveries:[],activeInvocations:[],inbox:originals.slice(0,through).map(event=>({id:event.id,digest:event.digest})),events:originals.slice(0,through).map(event=>({project_key:key,sequence:event.sequence,event_id:event.id,kind:event.kind,object_id:event.objectId,payload:canonicalize(event.payload)})),watermarks:[{project_key:key,sequence:through}]});
 for(const count of [1,5]){const valid=view(count);assert(exactView(valid,originals,count));for(const field of ['project_key','sequence','event_id','kind','object_id','payload'] as const){const changed=structuredClone(valid);(changed.events[0] as any)[field]=field==='sequence'?9:'changed';assert(!exactView(changed,originals,count),field);}const scopeChanged=structuredClone(valid);scopeChanged.scope.projectId='foreign';assert(!exactView(scopeChanged,originals,count));const watermarkChanged=structuredClone(valid);watermarkChanged.watermarks[0].project_key='foreign';assert(!exactView(watermarkChanged,originals,count));}
 const gap=view(1);gap.events.push(view(5).events[4]);assert(!exactView(gap,originals,1));const duplicate=view(5);duplicate.events[4]=structuredClone(duplicate.events[0]);assert(!exactView(duplicate,originals,5));
});
test('fresh deployment wrapper uses actual local Queue callbacks/attempts and D1 with strict fixed private controls',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'confidence-live-projector-local-')),bundle=join(dir,'bundle');await mkdir(bundle);
 const runId='11111111-1111-4111-8111-111111111111',workerName='confidence-projection-'+runId.replaceAll('-','').slice(0,20),queueName=workerName+'-events',source='sha256:'+'1'.repeat(64),control='owned-control-token-not-a-secret-00001';
 await promisify(execFile)(resolve('node_modules/.bin/wrangler'),['deploy','--dry-run','--config','infra/live-projection/wrangler.jsonc','--outdir',bundle],{cwd:resolve('.'),timeout:30000,maxBuffer:1024*1024,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
 const script=(await readdir(bundle)).find(name=>name.endsWith('.js'))!;
 const runtime=new Miniflare(convertV4MiniflareOptions({name:workerName,modulesRoot:bundle,modules:[{type:'ESModule',path:join(bundle,script)}],compatibilityDate:'2026-10-05',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'owned-live-projection-db'},queueProducers:{EVENTS:queueName},queueConsumers:{[queueName]:{maxBatchSize:32,maxBatchTimeout:0,maxRetries:10,deadLetterQueue:workerName+'-dlq'}},bindings:{RUN_ID:runId,RUN_EXPIRES_AT:String(Date.now()+20*60_000),SOURCE_SET_DIGEST:source,WORKER_NAME:workerName,QUEUE_NAME:queueName,DATABASE_ID:runId,CONTROL_TOKEN:control,PROJECTOR_SERVICE_TOKEN:'owned-projector-token-not-a-secret-0001'},log:new Log(LogLevel.ERROR)}));
 const request=(path:string,method='GET',headers:Record<string,string>={},body?:string)=>runtime.dispatchFetch('http://owned.test'+path,{method,headers:{authorization:'Bearer '+control,'x-owned-source-set':source,...headers},body});
 const inspect=async()=>{const response=await request('/inspect');assert.equal(response.status,200,await response.clone().text());return response.json() as Promise<Snapshot>;};
 const wait=async(predicate:(state:Snapshot)=>boolean)=>{for(let i=0;i<150;i++){const state=await inspect();if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('OWNED_LOCAL_DELIVERY_WINDOW_EXPIRED');};
 const stage=async(value:string)=>{const response=await request('/control/'+value,'POST');assert.equal(response.status,200,await response.clone().text());return response.json();};
 try {
  await runtime.ready;const migration=(await readFile('migrations/0001_projection.sql','utf8'))+'\n'+await readFile('infra/live-projection/probe.sql','utf8');await (await runtime.getD1Database('DB')).exec(migration.split('\n').filter(line=>line.trim()&&!line.trimStart().startsWith('--')).join('\n'));
  for(const response of [await request('/inspect','GET',{authorization:''}),await request('/inspect','GET',{'x-owned-source-set':'sha256:'+'2'.repeat(64)}),await request('/control/first','POST',{origin:'https://other.invalid'}),await request('/control/first','POST',{},'{}'),await request('/control/arbitrary','POST')])assert.notEqual(response.status,200);
  assert.equal((await inspect()).controls.length,0);
  const same=await Promise.all(Array.from({length:6},()=>request('/control/first','POST')));assert(same.every(response=>[200,409].includes(response.status)));
  await wait(state=>state.watermarks[0]?.sequence===1&&state.activeInvocations.length===0);const prior=await inspect();assert.equal(prior.controls[0].dispatches,1);assert.equal(prior.deliveries.length,1);assert.equal(prior.deliveries[0].attempt,1);assert.equal(prior.deliveries[0].action,'ACK_REQUESTED');
  assert.equal((await request('/control/first','POST')).status,200);assert.equal((await inspect()).controls.length,1);
  const originals=await originalEvents(runId);await stage('gap');const retried=await wait(state=>state.deliveries.some(row=>row.event_id.endsWith('/5')&&row.action==='RETRY_REQUESTED'));assert(exactView(retried,originals,1));
  await stage('recover');const recovered=await wait(state=>state.watermarks[0]?.sequence===5&&state.activeInvocations.length===0);const retry=retried.deliveries.find(row=>row.action==='RETRY_REQUESTED')!;assert(recovered.deliveries.some(row=>row.message_id===retry.message_id&&row.attempt>retry.attempt&&row.action==='ACK_REQUESTED'));
  await stage('duplicates');await wait(state=>state.deliveries.filter(row=>row.event_id.endsWith('/3')&&row.action==='ACK_REQUESTED').length===2&&state.activeInvocations.length===0);
  const database=await runtime.getD1Database('DB');await database.prepare("INSERT INTO probe_invocations VALUES('owned-active-barrier','ACTIVE',?)").bind(Date.now()).run();
  const beforeFence=await inspect();const denied=await request('/control/empty','POST');assert.equal(denied.status,409);assert.equal((await denied.json() as any).error.code,'ACTIVE_CONSUMER_FENCE');assert.deepEqual((await inspect()).events,beforeFence.events);assert.equal((await inspect()).consumer.consumer_gate,'OPEN');assert.equal((await request('/control/empty','POST')).status,409,'An unresolved fixed command cannot be repeated');
  // Remove only the explicit test-injected barrier and failed test command to
  // exercise the independent successful erase path in this LOCAL fixture.
  await database.batch([database.prepare("DELETE FROM probe_invocations WHERE id='owned-active-barrier'"),database.prepare("DELETE FROM probe_controls WHERE stage='empty'")]);
  await stage('empty');assert.deepEqual((await inspect()).events,[]);assert.equal((await inspect()).consumer.consumer_gate,'CLOSED');await stage('rebuild');const final=await wait(state=>state.watermarks[0]?.sequence===5&&state.activeInvocations.length===0);assert(exactView(final,originals,5));assert(final.controls.every(row=>row.dispatches===1));
 }finally{await runtime.dispose();await rm(dir,{recursive:true,force:true});}
});
