// SPDX-License-Identifier: Apache-2.0
// TEST ONLY. Never deploy: delivery is simulated and SQL inspection is exposed.
import projector from '../../workers/projector/index';
import authority, { ProjectAuthority } from '../../workers/authority/index';
import { canonicalize } from '../../packages/protocol/src/index';
import type { AuthorityEnv, TrustedCaller } from '../../workers/authority/types';
import type { Scope } from '../../packages/protocol/src/types';
import type { ProjectionEvent } from '../../workers/authority/types';

interface Env extends AuthorityEnv { DB: D1Database; AUTHORITY: Fetcher; NATIVE_QUEUE_BRIDGE?: string }
interface DeliveryRecord { id: string; acknowledgements: number; retries: { delaySeconds: number | null }[] }

async function deliver(events: ProjectionEvent[], env: Env): Promise<DeliveryRecord[]> {
  const records = events.map(event => ({ id: event.id, acknowledgements: 0, retries: [] } as DeliveryRecord));
  const messages: Message<ProjectionEvent>[] = events.map((event, index) => ({
    id: `owned-delivery-${index}`, timestamp: new Date('2026-10-01T00:00:00Z'), attempts: 1, body: event,
    ack() { records[index].acknowledgements++; },
    retry(options?: QueueRetryOptions) { records[index].retries.push({ delaySeconds: options?.delaySeconds ?? null }); },
  }));
  const batch: MessageBatch<ProjectionEvent> = {
    queue: 'owned-test-delivery-simulation', messages,
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
    ackAll() { for (const message of messages) message.ack(); },
    retryAll(options?: QueueRetryOptions) { for (const message of messages) message.retry(options); },
  };
  await projector.queue(batch, env);
  return records;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/internal/')) return authority.fetch(request, env);
    if (path === '/fixture/service-request') {
      const body = await request.json() as any;
      const configured = {...env, ...(body.config === 'missing' ? {PROJECTOR_SERVICE_TOKEN:undefined} : body.config === 'alias' ? {PROJECTOR_SERVICE_TOKEN:env.APP_SERVICE_TOKEN} : {})} as Env;
      return authority.fetch(new Request('https://authority.internal'+body.path,{method:body.method??'POST',headers:{authorization:body.token?'Bearer '+body.token:'','content-type':'application/json'},body:body.method==='GET'?undefined:body.raw}),configured);
    }
    if(path==='/fixture/late-page') return Response.json({completed:!!await env.OBJECTS.get('owned-late-page-completed')});
    if (path.startsWith('/fixture/')) {
      const body = await request.json() as any; const scope = body.scope as Scope; const stub = env.PROJECTS.getByName(`${scope.tenantId}/${scope.projectId}`) as DurableObjectStub<ProjectionAuthority>;
      if (path === '/fixture/seed') return Response.json(await stub.seedProjection(scope, body.count, body.large === true, body.payloadSize));
      if (path === '/fixture/inspect') return Response.json(await stub.inspectProjection());
      if (path === '/fixture/command') return stub.api('command', body);
      if (path === '/fixture/member') { await stub.member(body.subject, body.roles, body.active); return Response.json({done:true}); }
      if (path === '/fixture/pump') { await stub.pump(body.fail === true); return Response.json(await stub.inspectProjection()); }
      if (path === '/fixture/fail-next-send') { await stub.failNextSend(); return Response.json({done:true}); }
      if (path === '/fixture/corrupt') { await stub.corrupt(body.id, body.kind); return Response.json({done:true}); }
    }
    if (path === '/inspect') {
      // An actual D1 batch gives one consistent view of all three projections.
      const rows = await env.DB.batch([
        env.DB.prepare('SELECT id,digest FROM inbox ORDER BY id'),
        env.DB.prepare('SELECT project_key,sequence,event_id,kind,object_id,payload FROM events ORDER BY project_key,sequence'),
        env.DB.prepare('SELECT project_key,sequence FROM watermarks ORDER BY project_key'),
      ]);
      return Response.json({ inbox: rows[0].results, events: rows[1].results, watermarks: rows[2].results });
    }
    if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
    const body = await request.json() as { events?: ProjectionEvent[]; event?: ProjectionEvent; deliveries?: number };
    if (path === '/deliver' && Array.isArray(body.events) && body.events.length <= 32) {
      const control = body as {automatic?:boolean;historyMode?:string};
      let configured = control.automatic ? env : {DB:env.DB} as Env;
      if(control.historyMode === 'missing') configured={...env,PROJECTOR_SERVICE_TOKEN:undefined} as unknown as Env;
      else if(control.historyMode === 'wrong-token') configured={...env,PROJECTOR_SERVICE_TOKEN:'owned-wrong-token-not-a-secret-0000001'} as Env;
      else if(control.historyMode) configured={...env,AUTHORITY:{fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{
        const response=await env.AUTHORITY.fetch(input,init);if(response.status!==200)return response;
        const page=await response.json() as any;
        if(control.historyMode==='late-page'){const late=new Promise<Response>(resolve=>setTimeout(()=>resolve(new Response(canonicalize(page))),5100));ctx.waitUntil(late.then(()=>env.OBJECTS.put('owned-late-page-completed','true')));return late;}
        if(control.historyMode==='invalid-suffix') page.events[page.events.length-1].digest='sha256:'+'f'.repeat(64);
        if(control.historyMode==='cross-scope') page.events[page.events.length-1].scope.projectIncarnation='wrong-owned-incarnation';
        if(control.historyMode==='cursor') page.nextSequence++;
        if(control.historyMode==='oversize') return new Response('x'.repeat(128*1024+1));
        if(control.historyMode==='duplicate-json') return new Response('{"schemaVersion":1,'+canonicalize(page).slice(1));
        return new Response(canonicalize(page),{headers:{'content-type':'application/json'}});
      }}} as Env;
      return Response.json(await deliver(body.events,configured));
    }
    if (path === '/concurrent' && body.event && Number.isSafeInteger(body.deliveries) && body.deliveries! >= 2 && body.deliveries! <= 16) {
      // Independently invoke the unchanged handler, with one request-owned fake
      // MessageBatch per delivery; its D1 reads/writes execute concurrently.
      return Response.json((await Promise.all(Array.from({ length: body.deliveries! }, () => deliver([body.event!], { DB: env.DB } as Env)))).flat());
    }
    return Response.json({ error: 'INVALID_OWNED_TEST_REQUEST' }, { status: 400 });
  },
  async queue(batch: MessageBatch<ProjectionEvent>, env: Env): Promise<void> {
    if (env.NATIVE_QUEUE_BRIDGE !== 'true') throw Error('TEST_QUEUE_BRIDGE_DISABLED');
    await projector.queue(batch, env);
  },
} satisfies ExportedHandler<Env, ProjectionEvent>;

// Trusted test seeding; actual production command/history/alarm code is inherited.
export class ProjectionAuthority extends ProjectAuthority {
  constructor(ctx: DurableObjectState, env: AuthorityEnv) {
    super(ctx, { ...env, EVENTS: { send: async (event: unknown) => {
      if ((env as Env).NATIVE_QUEUE_BRIDGE === 'true') await env.EVENTS.send(event as ProjectionEvent);
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_sends(sequence INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL)');
      ctx.storage.sql.exec('INSERT INTO fixture_sends(payload) VALUES(?)',canonicalize(event));
      if (await ctx.storage.get('fail-send')) { await ctx.storage.delete('fail-send'); await ctx.storage.put('failed-event',(event as ProjectionEvent).id); throw Error('OWNED_LOST_SEND_RESPONSE'); }
    } } } as unknown as AuthorityEnv);
  }
  async seedProjection(scope: Scope, count: number, large: boolean, payloadSize = 0) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 400 || !Number.isSafeInteger(payloadSize) || payloadSize < 0 || payloadSize > 100000) throw Error('OWNED_SEED_LIMIT');
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.transactionSync(() => {
      const project = {scope,revision:'1',head:'a'.repeat(40),gate:'CLOSED',policyRevision:'1',goalRevision:'1',observationRevision:'0',publicationSequence:'0',unresolvedPublicationId:null,canonicalRepo:'owned-none',canonicalRef:'refs/heads/main',enrollmentDigest:'sha256:'+'0'.repeat(64),enrollment:{},previousReceiptDigest:null,maximumBudget:'100',reservedBudget:'0',settledBudget:'0'};
      this.ctx.storage.sql.exec('INSERT INTO project(singleton,revision,payload) VALUES(1,?,?)','1',canonicalize(project));
      this.ctx.storage.sql.exec('INSERT INTO memberships(subject,roles,active) VALUES(?,?,1)','owned-human',canonicalize(['admin','reader']));
      for(let i=1;i<=count;i++) (this as any).event(project,'owned-seeded-event',`object/${i}:value`,{value:i,...(large&&i===1?{large:'x'.repeat(100000)}:payloadSize?{large:'x'.repeat(payloadSize)}:{})});
      this.ctx.storage.sql.exec("UPDATE outbox SET state='DELIVERED' WHERE kind='projection'");
    });
    return this.inspectProjection();
  }
  async inspectProjection() {
    return {failedEvent:await this.ctx.storage.get('failed-event'),project:JSON.parse(this.ctx.storage.sql.exec<{payload:string}>('SELECT payload FROM project').one().payload),
      originals:this.ctx.storage.sql.exec<{payload:string;state:string}>("SELECT o.payload,o.state FROM events e JOIN outbox o ON o.id=e.id WHERE o.kind='projection' ORDER BY e.sequence").toArray().map(row=>({event:JSON.parse(row.payload),state:row.state})),
      replays:this.ctx.storage.sql.exec<{payload:string}>('SELECT payload FROM projection_replays ORDER BY id').toArray().map(row=>JSON.parse(row.payload)),
      tasks:this.ctx.storage.sql.exec<{id:string;payload:string;state:string}>("SELECT id,payload,state FROM outbox WHERE kind='projection-replay' ORDER BY rowid").toArray(),
      sent:this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='fixture_sends'").toArray().length?this.ctx.storage.sql.exec<{payload:string}>('SELECT payload FROM fixture_sends ORDER BY sequence').toArray().map(row=>JSON.parse(row.payload)):[]};
  }
  async member(subject:string,roles:string[],active:boolean) {this.ctx.storage.sql.exec('UPDATE memberships SET roles=?,active=? WHERE subject=?',canonicalize(roles),active?1:0,subject);}
  async pump(fail:boolean) {if(fail) await this.ctx.storage.put('fail-send',true); await this.alarm();await this.ctx.storage.deleteAlarm();}
  async failNextSend() {await this.ctx.storage.put('fail-send',true);}
  async corrupt(id:string,kind:string) {
    const row=this.ctx.storage.sql.exec<{payload:string}>("SELECT payload FROM outbox WHERE id=? AND kind='projection'",id).one();
    if(kind==='restore'){const original=await this.ctx.storage.get<string>('original-target');if(original)this.ctx.storage.sql.exec('UPDATE outbox SET payload=? WHERE id=?',original,id);return;}
    await this.ctx.storage.put('original-target',row.payload); const event=JSON.parse(row.payload);
    if(kind==='digest')event.digest='sha256:'+'f'.repeat(64);else event.sequence++;
    this.ctx.storage.sql.exec('UPDATE outbox SET payload=? WHERE id=?',canonicalize(event),id);
  }
}
