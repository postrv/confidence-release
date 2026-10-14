// SPDX-License-Identifier: Apache-2.0
// TEST ONLY. Control routes and owned credentials make this unsuitable for deployment.
import application from '../../workers/app/index';
import authority, { ProjectAuthority } from '../../workers/authority/index';
export { ProjectDirectory } from '../../workers/authority/index';
import type { AuthorityEnv, CandidateRecord } from '../../workers/authority/types';
import type { GitObject } from '../../packages/protocol/src/types';
import { ObjectStore } from '../../workers/shared/objects';

interface TestEnv extends AuthorityEnv {
  TEST_GIT_REMOTE: string; TEST_GIT_TOKEN: string; TEST_REPOSITORY: string; TEST_EVALUATOR: Fetcher;
  DEFAULT_PROJECT_ID: string;
}

/** Only external repository discovery/token transport is supplied by this fixture.
 * Ingestion, source construction, evaluation admission, publication and receipts
 * execute the unchanged production authority/repository implementations. */
export class WeftTestAuthority extends ProjectAuthority {
  constructor(ctx: DurableObjectState, env: TestEnv) {
    const artifacts = { async get(name: string) {
      if (name !== env.TEST_REPOSITORY) throw Object.assign(Error('Owned repository not found'), { code: 'NOT_FOUND' });
      return { [Symbol.dispose]() {},
        async info() { return { id: 'owned-artifacts-repository', name, remote: env.TEST_GIT_REMOTE, readOnly: false }; },
        async createToken() { return { plaintext: env.TEST_GIT_TOKEN }; }, async revokeToken() { return true; },
      };
    } };
    super(ctx, { ...env, ARTIFACTS: artifacts as unknown as Artifacts,
      EVENTS: { send: async () => {} } as unknown as Queue,
      RUNNER: { fetch: async () => new Response('Model execution disabled in owned test', { status: 503 }) } as unknown as Fetcher,
      EVALUATOR: env.TEST_EVALUATOR,
    });
  }
  override async alarm(): Promise<void> {}
  async step() {
    await super.alarm();
    await this.ctx.storage.deleteAlarm();
    return this.ctx.storage.sql.exec("SELECT id,kind,state FROM outbox WHERE state='PENDING'").toArray();
  }
  async drain() {
    for (let iteration = 0; iteration < 20; iteration++) {
      if (!this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE state='PENDING'").one().count) break;
      await super.alarm();
    }
    await this.ctx.storage.deleteAlarm();
    return this.ctx.storage.sql.exec("SELECT id,kind,state FROM outbox WHERE state='PENDING'").toArray();
  }
  async retainedObjects(candidateId: string): Promise<GitObject[]> {
    const row = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM records WHERE kind='candidate' AND id=?", candidateId).one();
    const candidate = JSON.parse(row.payload) as CandidateRecord;
    return JSON.parse(new TextDecoder().decode(await new ObjectStore(this.env.OBJECTS).get(candidate.source.objectsDigest, 64 * 1024 * 1024))) as GitObject[];
  }
}

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    const stub = env.PROJECTS.getByName(`${env.AUTH_TENANT_ID}/${env.DEFAULT_PROJECT_ID}`) as DurableObjectStub<WeftTestAuthority>;
    if (path === '/_test/drain') return Response.json(await stub.drain());
    if (path === '/_test/step') return Response.json(await stub.step());
    if (path === '/_test/evidence') return stub.api('evidence', await request.json());
    if (path === '/_test/objects') return Response.json(await stub.retainedObjects((await request.json() as { candidateId: string }).candidateId));
    return application.fetch(request, { ...env, AUTHORITY: { fetch: (input: RequestInfo | URL, init?: RequestInit) => authority.fetch(new Request(input, init), env) } } as never);
  },
};
