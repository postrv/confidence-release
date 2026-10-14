// TEST ONLY. Never deploy: synthetic membership/native state and an owned R2 fault switch.
import authority, { ProjectAuthority, ProjectDirectory as ProductionProjectDirectory } from '../../workers/authority/index';
import type { AuthorityEnv, ProjectRecord } from '../../workers/authority/types';
import { PlatformError } from '../../workers/shared/errors';
import { withinDeadline } from '../../workers/shared/deadline';
interface ReadControl { key: string | null; release: (() => void) | null; held: Promise<void> | null; entered: Promise<void> | null; notify: (() => void) | null; reads: Record<string, number> }
export class ProjectDirectory extends ProductionProjectDirectory {
  async inspectCommands(): Promise<unknown> { return this.ctx.storage.sql.exec('SELECT caller,id,payload,result FROM directory_commands').toArray(); }
}
export class TestProjectAuthority extends ProjectAuthority {
  private readControl: ReadControl;
  constructor(ctx: DurableObjectState, env: AuthorityEnv) {
    const bucket = env.OBJECTS;
    const readControl: ReadControl = { key: null, release: null, held: null, entered: null, notify: null, reads: {} };
    const objects = new Proxy(bucket, { get(target, property) {
      if (property === 'get') return async (...args: Parameters<R2Bucket['get']>) => {
        readControl.reads[args[0]] = (readControl.reads[args[0]] ?? 0) + 1;
        const result = await bucket.get(...args);
        if (args[0] === readControl.key) { readControl.notify?.(); await readControl.held; }
        return result;
      };
      if (property === 'put') return async (...args: Parameters<R2Bucket['put']>) => {
        if (await ctx.storage.get<boolean>('owned-import-failure')) throw new PlatformError('OWNED_R2_UNAVAILABLE', 503);
        return bucket.put(...args);
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    super(ctx, { ...env, OBJECTS: objects });
    this.readControl = readControl;
  }
  async testReadControl(input: { operation: 'arm' | 'wait' | 'release' | 'inspect'; digest?: string }): Promise<unknown> {
    const control = this.readControl;
    if (input.operation === 'arm') {
      control.key = `objects/sha256/${input.digest!.slice(7)}`;
      control.held = new Promise(resolve => { control.release = resolve; });
      control.entered = new Promise(resolve => { control.notify = resolve; });
    }
    if (input.operation === 'wait') await withinDeadline(() => control.entered!, 2000, 'OWNED_READ_DID_NOT_ENTER');
    if (input.operation === 'release') { control.key = null; control.release?.(); control.release = null; control.held = null; control.entered = null; control.notify = null; }
    return { reads: control.reads };
  }
  override async alarm(): Promise<void> {}
  override async api(...args: Parameters<ProjectAuthority['api']>): Promise<Response> {
    const response = await super.api(...args);
    const creation = (args[1] as { creation?: { name?: string } })?.creation;
    const stallCreation = args[0] === 'catalog-initialize' && creation?.name === 'Owned timed out creation'
      && !await this.ctx.storage.get<boolean>('owned-creation-response-stalled');
    const stallLookup = args[0] === 'catalog' && await this.ctx.storage.get<boolean>('owned-directory-read-stall');
    if (stallCreation || stallLookup) {
      if (stallCreation) await this.ctx.storage.put('owned-creation-response-stalled', true);
      if (stallLookup) await this.ctx.storage.delete('owned-directory-read-stall');
      await response.body?.cancel();
      return new Response(new ReadableStream(), { status: response.status, headers: response.headers });
    }
    return response;
  }
  async testChange(input: { operation: string; subject?: string; roles?: string[]; active?: boolean; projectId?: string }): Promise<void> {
    if (input.operation === 'member') this.ctx.storage.sql.exec('INSERT INTO memberships(subject,roles,active) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET roles=excluded.roles,active=excluded.active', input.subject!, JSON.stringify(input.roles!), input.active ? 1 : 0);
    if (input.operation === 'fault') await this.ctx.storage.put('owned-import-failure', input.active);
    if (input.operation === 'directory-read-stall') await this.ctx.storage.put('owned-directory-read-stall', true);
    if (input.operation === 'native') {
      const project: ProjectRecord = { scope: { schemaVersion: 1, tenantId: this.env.AUTH_TENANT_ID, projectId: input.projectId!, projectIncarnation: 'owned-native-incarnation' }, revision: '98', head: '1'.repeat(40), gate: 'CLOSED', policyRevision: '1', goalRevision: '1', observationRevision: '1', publicationSequence: '1', unresolvedPublicationId: null, canonicalRepo: 'existing-pilot', canonicalRef: 'refs/heads/main', enrollmentDigest: 'sha256:' + '1'.repeat(64), enrollment: { payloadType: 'application/vnd.in-toto+json', payload: '', signatures: [] }, previousReceiptDigest: null, maximumBudget: '0', reservedBudget: '0', settledBudget: '0' };
      this.ctx.storage.sql.exec('INSERT INTO project(singleton,revision,payload) VALUES(1,?,?)', project.revision, JSON.stringify(project));
      this.ctx.storage.sql.exec('INSERT INTO memberships(subject,roles,active) VALUES(?,?,1)', input.subject!, '["admin","reader"]');
    }
  }
}
export default {
  async fetch(request: Request, env: AuthorityEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/test/directory') {
      const directory = env.PROJECT_DIRECTORY.getByName(env.AUTH_TENANT_ID) as DurableObjectStub<ProjectDirectory>;
      return Response.json(await directory.inspectCommands());
    }
    if (path === '/test/change') {
      const input = await request.json() as { projectId: string; operation: string };
      const project = env.PROJECTS.getByName(`${env.AUTH_TENANT_ID}/${input.projectId}`) as DurableObjectStub<TestProjectAuthority>;
      await project.testChange(input); return Response.json({ ok: true });
    }
    if (path === '/test/read-control') {
      const input = await request.json() as { projectId: string; operation: 'arm' | 'wait' | 'release' | 'inspect'; digest?: string };
      const project = env.PROJECTS.getByName(`${env.AUTH_TENANT_ID}/${input.projectId}`) as DurableObjectStub<TestProjectAuthority>;
      return Response.json(await project.testReadControl(input));
    }
    if (path === '/test/object-change') {
      const input = await request.json() as { digest: string; operation: 'remove' | 'corrupt' | 'restore' };
      const key = `objects/sha256/${input.digest.slice(7)}`, backup = `owned-test-backup/${input.digest.slice(7)}`;
      const original = await env.OBJECTS.get(input.operation === 'restore' ? backup : key);
      if (!original) throw new Error('Owned object mutation requires retained original');
      if (input.operation === 'restore') { await env.OBJECTS.put(key, original.body); await env.OBJECTS.delete(backup); }
      else {
        await env.OBJECTS.put(backup, original.body);
        if (input.operation === 'remove') await env.OBJECTS.delete(key);
        else await env.OBJECTS.put(key, 'Owned corrupt archive bytes');
      }
      return Response.json({ ok: true });
    }
    if (path === '/test/object') {
      const input = await request.json() as { digest: string };
      const object = await env.OBJECTS.get(`objects/sha256/${input.digest.slice(7)}`);
      if (!object) return Response.json({ exists: false });
      const bytes = await object.arrayBuffer(); const digest = 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      return Response.json({ exists: true, bytes: bytes.byteLength, digest, head: (JSON.parse(new TextDecoder().decode(bytes)) as { head: string }).head });
    }
    return authority.fetch(request, env);
  },
} satisfies ExportedHandler<AuthorityEnv>;
