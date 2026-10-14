// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { accountGate, ownedJournal, classifyFailure, privateEnvironment, validEndpoint, applicationList, deploymentAvailable, atomic, boundedCapture, CaptureFailure, main } from '../live-container-check';
import type { Journal } from './types';
import { observeDetachedChild, type ChildProgress } from './child-observation';
import { continuationEligible, deployedRuntimeInputs, deployedWorkerMatches, deployedVariablesMatch } from './continuation';
const runId = '5bbfb0b1-cbb5-405e-8118-41a6edb8fec2';
const journal: Journal = { schemaVersion:1,runId,workerName:'confidence-live-5bbfb0b1cbb5405e8118',containerName:'confidence-live-5bbfb0b1cbb5405e8118-inert',createdAt:'2026-10-05T00:00:00Z',deploy:'NOT_DISPATCHED',start:'NOT_DISPATCHED',stop:'NOT_DISPATCHED',workerDelete:'NOT_DISPATCHED',unresolvedResources:[],observations:[],checks:[] };
test('owned names cannot target an existing arbitrary Worker',()=>{assert(ownedJournal(journal));assert(!ownedJournal({...journal,workerName:'production'}));assert(!ownedJournal({...journal,containerName:'production'}));});
test('uncertain deploy/start/cleanup always requires reconciliation',()=>{for(const field of ['deploy','start','stop','workerDelete'] as const){assert.equal(classifyFailure({...journal,[field]:'MAY_HAVE_DISPATCHED'}),'RECONCILIATION_REQUIRED');assert.equal(classifyFailure({...journal,[field]:'UNKNOWN'}),'RECONCILIATION_REQUIRED');}});
test('existing account and both native permissions gate mutation',()=>{const account='a'.repeat(32);const raw=(permissions:string[])=>JSON.stringify({loggedIn:true,authType:'OAuth Token',accounts:[{id:account,name:'private'}],email:'private@example.invalid',tokenPermissions:permissions});assert.equal(accountGate(raw(['workers:write','containers:write']),account).status,'PASS');assert.equal(accountGate(raw(['workers:write']),account).status,'BLOCKED');assert.equal(accountGate(raw(['workers:write','containers:write']),'b'.repeat(32)).status,'BLOCKED');assert(!JSON.stringify(accountGate(raw(['workers:write','containers:write']),account)).includes('private'));});
test('private Wrangler env omits alternate credentials and local secret logs',()=>{const env=privateEnvironment('a'.repeat(32));assert.equal(env.WRANGLER_WRITE_LOGS,'false');assert.equal(env.WRANGLER_SEND_METRICS,'false');assert.equal(env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(env.CF_API_KEY,undefined);});
test('only the exact owned Workers endpoint is accepted',()=>{assert(validEndpoint(`https://${journal.workerName}.owned.workers.dev/`,journal.workerName));for(const bad of ['http://localhost/','https://production.owned.workers.dev/',`https://${journal.workerName}.owned.workers.dev/path`,`https://${journal.workerName}.owned.workers.dev/?token=private`])assert(!validEndpoint(bad,journal.workerName));});
test('Container REST lists require the actual successful complete response envelope',()=>{
  assert.deepEqual(applicationList({success:true,errors:[],result:[],result_info:{next_page_token:null}}),{count:0,complete:true});
  assert.deepEqual(applicationList({success:true,errors:[],result:[{id:'owned'}],result_info:{next_page_token:'next'}}),{count:1,complete:false});
  for(const invalid of [[],{success:false,errors:[],result:[]},{success:true,errors:[{code:10000}],result:[]},{success:true,errors:[],result:[],result_info:{next_page_token:1}}])assert.equal(applicationList(invalid),null);
});
test('delayed deployment routes and missing association never admit an early start',async()=>{
  let reads=0,associations=0,starts=0;
  const ready={runId,observationClass:'deployed-native-container',generation:null,container:null};
  const result=await deploymentAvailable({runId,attempts:4,pause:async()=>{},inspect:async()=>{assert.equal(starts,0);reads++;return reads===1?{status:503,body:null}:reads===2?{status:200,body:{...ready,runId:'other'}}:{status:200,body:ready};},associated:async()=>++associations===2});
  if(result.ready)starts++;
  assert.equal(reads,4);assert.equal(associations,2);assert.equal(starts,1);assert.equal(result.associationVerified,true);
  const unavailable=await deploymentAvailable({runId,attempts:2,pause:async()=>{},inspect:async()=>({status:502,body:null}),associated:async()=>{throw Error('MUST_NOT_CHECK_ASSOCIATION');}});
  assert.equal(unavailable.ready,false);
  const occupied=await deploymentAvailable({runId,attempts:2,pause:async()=>{},inspect:async()=>({status:200,body:{...ready,generation:{phase:'UNKNOWN'}}}),associated:async()=>true});
  assert.equal(occupied.ready,false);assert.equal(occupied.attempts,1);
});
test('long subprocesses leave the event loop available',async()=>{
  let ticks=0;const timer=setInterval(()=>ticks++,10);
  try{assert.equal(await boundedCapture(process.execPath,['-e',"setTimeout(()=>process.stdout.write('done'),150)"],{timeout:2000}),'done');assert(ticks>=3);}
  finally{clearInterval(timer);}
});
test('oversized, timed out and failed subprocesses expose only sanitized classifications',async()=>{
  for(const [code,reason,options] of [
    ["process.stdout.write('PRIVATE_SENTINEL'.repeat(1000))",'OUTPUT_LIMIT',{maximum:64,timeout:2000}],
    ["process.stderr.write('PRIVATE_SENTINEL');setInterval(()=>{},1000)",'TIMEOUT',{timeout:100}],
    ["process.stderr.write('PRIVATE_SENTINEL');process.exit(7)",'EXIT_FAILURE',{timeout:2000}],
  ] as const){await assert.rejects(boundedCapture(process.execPath,['-e',code],options),error=>error instanceof CaptureFailure&&error.reason===reason&&!String(error).includes('PRIVATE_SENTINEL')&&!JSON.stringify(error).includes('PRIVATE_SENTINEL'));}
});
test('atomic journal replacement retains private mode and complete JSON',async()=>{
  const directory=fileURLToPath(new URL(`.runs/unit-${randomUUID()}/nested/`,import.meta.url));const path=`${directory}journal.json`;
  try{await atomic(path,{phase:'NOT_DISPATCHED'});await atomic(path,{phase:'MAY_HAVE_DISPATCHED',resources:['owned']});assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{phase:'MAY_HAVE_DISPATCHED',resources:['owned']});assert.equal((await stat(path)).mode&0o777,0o600);}
  finally{await rm(dirname(dirname(path)),{recursive:true,force:true});}
});
test('default execution is BLOCKED and never calls a remote fetch',async()=>{const directory=fileURLToPath(new URL(`.runs/unit-${randomUUID()}/`,import.meta.url));const previous=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('REMOTE_FETCH_FORBIDDEN');};try{const report=await main(['--out',`${directory}report.json`]);assert.equal(report.status,'BLOCKED');assert.equal(report.providerGatePassed,false);assert.equal(report.journal,undefined);}finally{globalThis.fetch=previous;await rm(directory,{recursive:true,force:true});}});
test('a locked uncertain journal is neither replayed nor overwritten',async()=>{const directory=fileURLToPath(new URL(`.runs/unit-${randomUUID()}/`,import.meta.url));await mkdir(directory,{recursive:true});const path=`${directory}journal.json`;const existing=JSON.stringify({...journal,deploy:'MAY_HAVE_DISPATCHED',unresolvedResources:[journal.workerName,journal.containerName]});await writeFile(path,existing);await writeFile(`${path}.lock`,'owned by another process');const previous=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('REMOTE_FETCH_FORBIDDEN');};try{const report=await main(['--run','--journal',path,'--out',`${directory}report.json`]);assert.equal(report.status,'RECONCILIATION_REQUIRED');assert.equal(report.providerGatePassed,false);assert.equal(await readFile(path,'utf8'),existing);assert.equal(await readFile(`${path}.lock`,'utf8'),'owned by another process');}finally{globalThis.fetch=previous;await rm(directory,{recursive:true,force:true});}});
test('a start-only uncertain journal retains reconciliation classification even when deployment says not dispatched',async()=>{
  const directory=fileURLToPath(new URL(`.runs/unit-${randomUUID()}/`,import.meta.url));await mkdir(directory,{recursive:true});const path=`${directory}journal.json`;
  const existing=JSON.stringify({...journal,start:'UNKNOWN',unresolvedResources:[journal.workerName]});await writeFile(path,existing);await writeFile(`${path}.lock`,'owned by another process');
  try{const report=await main(['--run','--journal',path,'--out',`${directory}report.json`]);assert.equal(report.status,'RECONCILIATION_REQUIRED');assert.equal(await readFile(path,'utf8'),existing);}
  finally{await rm(directory,{recursive:true,force:true});}
});

const resultFile = JSON.stringify({ schemaVersion: 1, pid: 1234, first: '1791170000001', second: '1791170000002' });
const diagnosticFile = JSON.stringify({ schemaVersion: 1, stage: 'FIRST_HEARTBEAT', code: 'FIRST_HEARTBEAT_TIMEOUT', elapsedMs: 10000, pid: 1234, exitCode: null });
test('detached child observation awaits only the parent exit and never descendant output', async () => {
  const progress: ChildProgress[] = []; let reads = 0, outputCalls = 0;
  const result = await observeDetachedChild({
    async exec(argv, options) {
      assert.deepEqual(argv, ['node', '/opt/preflight/child.mjs']); assert.equal(options.stdout, 'ignore'); assert.equal(options.stderr, 'ignore');
      return { pid: 42, exitCode: Promise.resolve(0), output: () => { outputCalls++; return new Promise(() => {}); } };
    },
    async readFile(path) { assert.ok(progress.some(item => item.stage === 'PARENT_EXITED' && item.parentExitCode === 0)); return new Response(path.endsWith('child-result.json') ? resultFile : String(1791170000003 + reads++)); },
    async record(value) { progress.push(value); }, wait: async () => {},
  });
  assert.equal(outputCalls, 0); assert.equal(result.pid, 1234); assert.equal(reads, 2);
  assert.deepEqual(progress.map(item => item.stage), ['RESERVED', 'PARENT_DISPATCHED', 'PARENT_EXITED', 'RESULT_OBSERVED', 'HEARTBEAT_OBSERVED']);
});
test('parent nonzero retains one closed diagnostic read without a result read or repeat dispatch', async () => {
  const progress: ChildProgress[] = []; let executions = 0, reads = 0;
  await assert.rejects(observeDetachedChild({ exec: async () => { executions++; return { pid: 42, exitCode: Promise.resolve(7) }; }, readFile: async path => { reads++; assert.equal(path, '/workspace/child-diagnostic.json'); return new Response(diagnosticFile); }, record: async value => { progress.push(value); } }), /PARENT_NONZERO/);
  assert.equal(progress.at(-1)?.stage, 'PARENT_EXITED'); assert.equal(progress.at(-1)?.parentExitCode, 7); assert.equal(progress.at(-1)?.failureCode, 'PARENT_NONZERO');
  assert.equal(executions, 1); assert.equal(reads, 1); assert.equal(progress.at(-1)?.childDiagnosticStatus, 'VALID');
  assert.equal(progress.at(-1)?.childDiagnostic?.code, 'FIRST_HEARTBEAT_TIMEOUT');
});
test('malformed or missing child diagnostics preserve observed nonzero and never retry spawn', async () => {
  for (const raw of ['{', 'null', '{}', 'x'.repeat(1025), diagnosticFile.replace('10000', '60001'), diagnosticFile.replace('FIRST_HEARTBEAT_TIMEOUT', 'PRIVATE_NATIVE_ERROR'), diagnosticFile.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'), diagnosticFile.replace('"exitCode":null', '"exitCode":null,"extra":"PRIVATE"')]) {
    const progress: ChildProgress[] = []; let executions = 0, reads = 0;
    await assert.rejects(observeDetachedChild({ exec: async () => { executions++; return { pid: 42, exitCode: Promise.resolve(1) }; }, readFile: async () => { reads++; return new Response(raw); }, record: async value => { progress.push(value); } }), /PARENT_NONZERO/);
    assert.equal(executions, 1); assert.equal(reads, 1); assert.equal(progress.at(-1)?.childDiagnosticStatus, 'INVALID');
    assert.equal(progress.at(-1)?.parentExitCode, 1); assert.equal(progress.at(-1)?.childDiagnostic, undefined);
    assert.ok(!JSON.stringify(progress).includes('PRIVATE'));
  }
  for (const readFile of [async () => new Response(null, { status: 404 }), async () => { throw Error('PRIVATE_NATIVE_READ_FAILURE'); }]) {
    const progress: ChildProgress[] = [];
    await assert.rejects(observeDetachedChild({ exec: async () => ({ pid: 42, exitCode: Promise.resolve(1) }), readFile, record: async value => { progress.push(value); } }), /PARENT_NONZERO/);
    assert.equal(progress.at(-1)?.childDiagnosticStatus, 'UNOBSERVED'); assert.equal(progress.at(-1)?.parentExitCode, 1);
    assert.ok(!JSON.stringify(progress).includes('PRIVATE'));
  }
});
test('an already-exited parent is never signalled while progress retention yields', async () => {
  let signal: AbortSignal | undefined, reads = 0;
  await observeDetachedChild({
    exec: async (_argv, options) => { signal = options.signal; return { pid: 42, exitCode: Promise.resolve(0) }; },
    readFile: async path => new Response(path.endsWith('child-result.json') ? resultFile : String(1791170000003 + reads++)),
    record: async value => { if (value.stage === 'PARENT_DISPATCHED') { await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(signal?.aborted, false); } },
    wait: async () => {}, parentTimeout: 10,
  });
  assert.equal(signal?.aborted, false);
});
test('unobserved parent completion aborts its request but retains uncertain dispatched stage', async () => {
  const progress: ChildProgress[] = []; let signal: AbortSignal | undefined;
  await assert.rejects(observeDetachedChild({ exec: async (_argv, options) => { signal = options.signal; return { pid: 42, exitCode: new Promise(() => {}) }; }, readFile: async () => { throw Error('MUST_NOT_READ'); }, record: async value => { progress.push(value); }, parentTimeout: 10 }), /PARENT_COMPLETION_UNOBSERVED/);
  assert.equal(signal?.aborted, true); assert.equal(progress.at(-1)?.stage, 'PARENT_DISPATCHED'); assert.equal(progress.at(-1)?.failureCode, 'PARENT_COMPLETION_UNOBSERVED'); assert.equal(progress.at(-1)?.parentExitCode, undefined);
});
test('missing, malformed and oversized fixed child result cannot acknowledge a heartbeat', async () => {
  for (const raw of ['{', 'null', '{}', resultFile.replace('1791170000002', '1791170000001'), 'x'.repeat(1025)]) {
    const progress: ChildProgress[] = []; let reads = 0;
    await assert.rejects(observeDetachedChild({ exec: async () => ({ pid: 42, exitCode: Promise.resolve(0) }), readFile: async () => { reads++; return new Response(raw); }, record: async value => { progress.push(value); } }), /RESULT_INVALID/);
    assert.equal(reads, 1); assert.equal(progress.at(-1)?.stage, 'PARENT_EXITED'); assert.equal(progress.at(-1)?.failureCode, 'RESULT_INVALID');
  }
});
test('unchanged heartbeat after a successfully exited parent stays unacknowledged', async () => {
  const progress: ChildProgress[] = []; let time = 0, executions = 0;
  await assert.rejects(observeDetachedChild({ exec: async () => { executions++; return { pid: 42, exitCode: Promise.resolve(0) }; }, readFile: async path => new Response(path.endsWith('child-result.json') ? resultFile : '1791170000003'), record: async value => { progress.push(value); }, wait: async milliseconds => { time += milliseconds; }, now: () => time }), /CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT/);
  assert.equal(progress.at(-1)?.stage, 'RESULT_OBSERVED'); assert.equal(progress.at(-1)?.failureCode, 'CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT');
  assert.equal(time, 5000); assert.equal(executions, 1);
});
test('post-parent heartbeat changes after350ms can be observed under one5second budget', async () => {
  const progress: ChildProgress[] = []; let time = 0, executions = 0; let signal: AbortSignal | undefined;
  const result = await observeDetachedChild({ exec: async (_argv, options) => { executions++; signal = options.signal; return { pid: 42, exitCode: Promise.resolve(0) }; },
    readFile: async path => new Response(path.endsWith('child-result.json') ? resultFile : time < 700 ? '1791170000003' : '1791170000004'),
    record: async value => { progress.push(value); }, wait: async milliseconds => { time += milliseconds; assert.equal(signal?.aborted, false); }, now: () => time });
  assert.equal(time, 700); assert.equal(executions, 1); assert.equal(result.heartbeat, '1791170000004');
  assert.equal(signal?.aborted, false); assert.equal(progress.at(-1)?.stage, 'HEARTBEAT_OBSERVED');
});
test('unresolved host heartbeat reads, streams and waits cannot outlive post-exit budget', async () => {
  for (const kind of ['read', 'second', 'stream', 'wait'] as const) {
    const progress: ChildProgress[] = []; let signal: AbortSignal | undefined, executions = 0, heartbeatReads = 0;
    await assert.rejects(observeDetachedChild({
      exec: async (_argv, options) => { executions++; signal = options.signal; return { pid: 42, exitCode: Promise.resolve(0) }; },
      readFile: async path => path.endsWith('child-result.json') ? new Response(resultFile) : kind === 'read' || (kind === 'second' && heartbeatReads++ > 0) ? new Promise<Response>(() => {}) : kind === 'stream' ? new Response(new ReadableStream<Uint8Array>()) : new Response('1791170000003'),
      wait: async () => kind === 'wait' ? new Promise<void>(() => {}) : undefined,
      record: async value => { progress.push(value); }, postExitTimeout: 100,
    }), /CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT/);
    assert.equal(executions, 1); assert.equal(signal?.aborted, false);
    assert.equal(progress.at(-1)?.failureCode, 'CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT');
    assert.ok(!progress.some(value => value.stage === 'HEARTBEAT_OBSERVED' && !value.failureCode));
  }
});
test('late final progress retention rejects acknowledgment and retains failure', async () => {
  const progress: ChildProgress[] = []; let time = 0, reads = 0, executions = 0;
  await assert.rejects(observeDetachedChild({
    exec: async () => { executions++; return { pid: 42, exitCode: Promise.resolve(0) }; },
    readFile: async path => new Response(path.endsWith('child-result.json') ? resultFile : String(1791170000003 + reads++)),
    record: async value => { progress.push(value); if (value.stage === 'HEARTBEAT_OBSERVED' && !value.failureCode) time = 6000; },
    wait: async () => {}, now: () => time,
  }), /CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT/);
  assert.equal(executions, 1); assert.equal(progress.at(-1)?.failureCode, 'CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT');
});
test('unresolved final progress and failure retention cannot reopen acknowledgment', async () => {
  let executions = 0, signal: AbortSignal | undefined, reads = 0; const started = Date.now();
  await assert.rejects(observeDetachedChild({
    exec: async (_argv, options) => { executions++; signal = options.signal; return { pid: 42, exitCode: Promise.resolve(0) }; },
    readFile: async path => new Response(path.endsWith('child-result.json') ? resultFile : String(1791170000003 + reads++)),
    record: async value => { if (value.stage === 'HEARTBEAT_OBSERVED') return new Promise<void>(() => {}); },
    wait: async () => {}, postExitTimeout: 100,
  }), /CHILD_NOT_OBSERVED_AFTER_PARENT_EXIT/);
  assert.equal(executions, 1); assert.equal(signal?.aborted, false); assert.ok(Date.now() - started < 1500);
});
test('native exceptions persist only a closed stage classification, never their raw detail', async () => {
  const progress: ChildProgress[] = [];
  await assert.rejects(observeDetachedChild({ exec: async () => { throw Error('PRIVATE_NATIVE_DETAIL'); }, readFile: async () => { throw Error('MUST_NOT_READ'); }, record: async value => { progress.push(value); } }));
  assert.equal(progress.at(-1)?.stage, 'RESERVED'); assert.equal(progress.at(-1)?.failureCode, 'CHILD_PROBE_STEP_UNKNOWN'); assert.ok(!JSON.stringify(progress).includes('PRIVATE_NATIVE_DETAIL'));
});
test('continuation admits only the unchanged acknowledged deployment before any start', () => {
  const account = 'a'.repeat(32), endpoint = `https://${journal.workerName}.owned.workers.dev/`;
  const before = { ...journal, accountId: account, endpoint, deploy: 'ACKNOWLEDGED' as const };
  const hashes = Object.fromEntries(deployedRuntimeInputs.map(path => [path, 'sha256:' + 'b'.repeat(64)]));
  const original: any = { status: 'BLOCKED', providerGatePassed: false, sourceDigests: hashes, journal: before };
  const template: any = { main: 'worker.ts', containers: [{ name: 'package-only', images: { inert: { dockerfile: 'Dockerfile' } } }] };
  const paths = { worker: '/owned/worker.ts', dockerfile: '/owned/Dockerfile', directory: '/owned' }, now = 1791170000000;
  const config: any = { ...structuredClone(template), name: before.workerName, account_id: account, main: paths.worker, vars: { RUN_ID: before.runId, RUN_EXPIRES_AT: String(now + 300000) } }; config.containers[0].name = before.containerName; config.containers[0].images.inert = { dockerfile: paths.dockerfile, build_context: paths.directory };
  const check = (state: any = before, proof: any = original, concrete: any = config, current: any = hashes, selected = account, at = now) => continuationEligible(state, proof, concrete, template, current, selected, at, paths);
  assert.equal(check(), true);
  for (const field of ['deploy', 'start', 'stop', 'workerDelete'] as const) for (const phase of ['UNKNOWN', 'MAY_HAVE_DISPATCHED']) assert.equal(check({ ...before, [field]: phase }), false);
  assert.equal(check({ ...before, start: 'ACKNOWLEDGED' }), false); assert.equal(check(before, { ...original, journal: { ...before, start: 'UNKNOWN' } }), false);
  assert.equal(check(before, original, config, { ...hashes, 'child.mjs': 'sha256:' + 'c'.repeat(64) }), false);
  assert.equal(check(before, original, { ...config, extraBinding: 'unexpected' }), false); assert.equal(check(before, original, config, hashes, 'c'.repeat(32)), false);
  assert.equal(check(before, original, config, hashes, account, now + 300000), false); assert.equal(check(before, { ...original, journal: { ...before, endpoint: 'other' } }), false);
});
test('deployed code readback is bounded and requires the exact retained main module', async () => {
  const bytes = new TextEncoder().encode('export default {};');
  assert.equal(await deployedWorkerMatches(new Response(bytes, { headers: { 'content-type': 'application/javascript' } }), bytes), true);
  assert.equal(await deployedWorkerMatches(new Response('changed', { headers: { 'content-type': 'application/javascript' } }), bytes), false);
  const form = new FormData(); form.set('worker.js', new File([bytes], 'worker.js')); const response = new Response(form); response.headers.set('cf-entrypoint', 'worker.js');
  assert.equal(await deployedWorkerMatches(response, bytes), true);
  const extra = new FormData(); extra.set('worker.js', new File([bytes], 'worker.js')); extra.set('other.js', new File(['other'], 'other.js')); const bad = new Response(extra); bad.headers.set('cf-entrypoint', 'worker.js');
  assert.equal(await deployedWorkerMatches(bad, bytes), false); assert.equal(await deployedWorkerMatches(new Response('x'.repeat(256 * 1024 + 1), { headers: { 'content-type': 'application/javascript' } }), bytes), false);
});
test('continuation verifies live expiry, run variables and compatibility without changing them', () => {
  const config = { vars: { RUN_ID: runId, RUN_EXPIRES_AT: '1791170000000' }, compatibility_date: '2026-10-05', compatibility_flags: ['nodejs_compat'] };
  const settings = { success: true, result: { ...config, bindings: Object.entries(config.vars).map(([name, text]) => ({ type: 'plain_text', name, text })) } };
  assert.equal(deployedVariablesMatch(settings, config), true); assert.equal(deployedVariablesMatch({ ...settings, result: { ...settings.result, bindings: settings.result.bindings.slice(1) } }, config), false);
  assert.equal(deployedVariablesMatch(settings, { ...config, vars: { ...config.vars, RUN_EXPIRES_AT: '1791170000001' } }), false);
});

test('continuation CLI rejects ambiguous prior effects before authentication or remote requests', async () => {
  const directory = fileURLToPath(new URL(`.runs/unit-${randomUUID()}/`, import.meta.url));
  await mkdir(directory, { recursive: true });
  const path = `${directory}journal.json`, proofPath = `${directory}deployment.json`;
  const before = { ...journal, accountId: 'a'.repeat(32), endpoint: `https://${journal.workerName}.owned.workers.dev/`, deploy: 'ACKNOWLEDGED' as const };
  const proof = JSON.stringify({ schemaVersion: 1, status: 'BLOCKED', providerGatePassed: false, sourceDigests: {}, journal: before });
  await writeFile(proofPath, proof); await writeFile(`${directory}wrangler.json`, '{}');
  const previous = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw Error('REMOTE_FETCH_FORBIDDEN'); };
  try {
    let index = 0;
    for (const field of ['deploy', 'start', 'stop', 'workerDelete'] as const) for (const phase of ['UNKNOWN', 'MAY_HAVE_DISPATCHED'] as const) {
      const uncertain = { ...before, [field]: phase }; await writeFile(path, JSON.stringify(uncertain));
      const result = await main(['--continue-before-start', '--journal', path, '--deployment-report', proofPath, '--out', `${directory}report-${index++}.json`, '--account', before.accountId]);
      assert.equal(result.status, 'RECONCILIATION_REQUIRED'); assert.equal(result.providerGatePassed, false);
      assert.equal(result.checks.find(check => check.name === 'untouched-deployment-before-start')?.status, 'BLOCKED');
      assert.ok(!result.checks.some(check => check.name === 'selected-existing-wrangler-account'));
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), uncertain);
      assert.equal(await readFile(proofPath, 'utf8'), proof);
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previous; await rm(directory, { recursive: true, force: true }); }
});

test('continuation CLI cannot overwrite its original proof or journal or combine mutation modes', async () => {
  const directory = fileURLToPath(new URL(`.runs/unit-${randomUUID()}/`, import.meta.url));
  await mkdir(directory, { recursive: true });
  const path = `${directory}journal.json`, proofPath = `${directory}deployment.json`, out = `${directory}report.json`;
  const proof = '{"retained":"original immutable proof"}', retainedJournal = JSON.stringify(journal);
  await writeFile(proofPath, proof); await writeFile(path, retainedJournal);
  const base = ['--continue-before-start', '--journal', path, '--deployment-report', proofPath];
  const previous = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw Error('REMOTE_FETCH_FORBIDDEN'); };
  try {
    for (const argv of [base, [...base, '--out', proofPath], [...base, '--out', path], ...['--run', '--reconcile', '--stop', '--prepare', '--package', '--self-test', '--check-account'].map(mode => [...base, '--out', out, mode]), ['--continue-before-start', '--journal', path, '--out', out]]) {
      await assert.rejects(main(argv), /DISTINCT_CONTINUATION_PROOF_AND_REPORT_REQUIRED/);
    }
    assert.equal(await readFile(proofPath, 'utf8'), proof); assert.equal(await readFile(path, 'utf8'), retainedJournal);
    await assert.rejects(stat(out), { code: 'ENOENT' }); assert.equal(requests, 0);
  } finally { globalThis.fetch = previous; await rm(directory, { recursive: true, force: true }); }
});
