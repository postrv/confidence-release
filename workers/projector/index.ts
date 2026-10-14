// SPDX-License-Identifier: Apache-2.0
import { canonicalize, digest } from '../../packages/protocol/src/index';
import type { ProjectionEvent } from '../authority/types';
import { PlatformError, readBounded, requireValue } from '../shared/errors';
import { closed, projectionEvent, PROJECTION_PAGE_BYTES, PROJECTION_PAGE_SIZE, type ProjectionHistoryRequest, type ProjectionHistoryPage } from '../shared/projection';
export interface ProjectionEnv { DB: D1Database; AUTHORITY?: Fetcher; PROJECTOR_SERVICE_TOKEN?: string }
const projectKey = (event: ProjectionEvent) => `${event.scope.tenantId}/${event.scope.projectId}/${event.scope.projectIncarnation}`;
async function valid(event: ProjectionEvent): Promise<void> { projectionEvent(event); const { digest: expected, ...identity } = event; requireValue(await digest(identity) === expected, 'EVENT_DIGEST_MISMATCH'); }
async function watermark(event: ProjectionEvent, env: ProjectionEnv): Promise<number> { return (await env.DB.prepare('SELECT sequence FROM watermarks WHERE project_key=?').bind(projectKey(event)).first<{ sequence: number }>())?.sequence ?? 0; }
async function apply(event: ProjectionEvent, env: ProjectionEnv): Promise<boolean> {
  await valid(event);
  const prior = await env.DB.prepare('SELECT digest FROM inbox WHERE id=?').bind(event.id).first<{ digest: string }>();
  if (prior) { requireValue(prior.digest === event.digest, 'INBOX_IDENTITY_CONFLICT'); return true; }
  if (event.sequence !== await watermark(event, env) + 1) return false;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO inbox(id,digest) VALUES(?,?)').bind(event.id, event.digest),
    env.DB.prepare('INSERT INTO events(project_key,sequence,event_id,kind,object_id,payload) VALUES(?,?,?,?,?,?)').bind(projectKey(event), event.sequence, event.id, event.kind, event.objectId, canonicalize(event.payload)),
    env.DB.prepare('INSERT INTO watermarks(project_key,sequence) VALUES(?,?) ON CONFLICT(project_key) DO UPDATE SET sequence=excluded.sequence WHERE watermarks.sequence=excluded.sequence-1').bind(projectKey(event), event.sequence),
  ]);
  return true;
}
async function catchup(event: ProjectionEvent, afterSequence: number, env: ProjectionEnv): Promise<void> {
  if (!env.AUTHORITY || typeof env.PROJECTOR_SERVICE_TOKEN !== 'string' || env.PROJECTOR_SERVICE_TOKEN.length < 32) return;
  const request: ProjectionHistoryRequest = { schemaVersion: 1, scope: event.scope, afterSequence, throughSequence: event.sequence - 1, target: { id: event.id, digest: event.digest, sequence: event.sequence } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const page = await Promise.race([(async () => {
      const response = await env.AUTHORITY!.fetch('https://authority.internal/internal/projection/history', { method: 'POST', redirect: 'manual', signal: controller.signal, headers: { authorization: `Bearer ${env.PROJECTOR_SERVICE_TOKEN}`, 'content-type': 'application/json' }, body: canonicalize(request) });
      requireValue(response.status === 200, 'PROJECTION_HISTORY_DENIED');
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response.body, PROJECTION_PAGE_BYTES));
      const result: unknown = JSON.parse(raw); requireValue(canonicalize(result) === raw, 'PROJECTION_HISTORY_ENCODING');
      closed(result, ['schemaVersion', 'scope', 'afterSequence', 'throughSequence', 'target', 'events', 'nextSequence', 'complete']);
      requireValue(result.schemaVersion === 1 && canonicalize(result.scope) === canonicalize(request.scope) && result.afterSequence === request.afterSequence && result.throughSequence === request.throughSequence && canonicalize(result.target) === canonicalize(request.target) && Array.isArray(result.events) && result.events.length > 0 && result.events.length <= PROJECTION_PAGE_SIZE, 'PROJECTION_HISTORY_MISMATCH');
      for (let i = 0; i < result.events.length; i++) { const original = result.events[i]; projectionEvent(original); await valid(original); requireValue(canonicalize(original.scope) === canonicalize(event.scope) && original.sequence === afterSequence + i + 1 && original.sequence <= request.throughSequence, 'PROJECTION_HISTORY_NONCONTIGUOUS'); }
      requireValue(result.nextSequence === afterSequence + result.events.length && result.complete === (result.nextSequence === request.throughSequence), 'PROJECTION_HISTORY_CURSOR');
      return result as unknown as ProjectionHistoryPage;
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('PROJECTION_HISTORY_TIMEOUT')); }, 5_000); })]);
    // Validate the complete bounded page before the first D1 write. Late reads
    // cannot continue here after the Promise.race rejected the request.
    for (const original of page.events) if (!await apply(original, env)) break;
  } finally { clearTimeout(timer); }
}
/** Rebuildable view only. Authority history can repair a bounded prefix; long
 * or unavailable gaps remain retry/DLQ work for explicit paged replay. */
export default {
  async queue(batch: MessageBatch<ProjectionEvent>, env: ProjectionEnv): Promise<void> {
    for (const message of batch.messages) {
      const event = message.body;
      try {
        if (await apply(event, env)) { message.ack(); continue; }
        const current = await watermark(event, env);
        if (event.sequence > current + 1) await catchup(event, current, env);
        if (await apply(event, env)) message.ack(); else message.retry({ delaySeconds: 5 });
      } catch (error) { console.log(JSON.stringify({type:'projection-retry',code:error instanceof PlatformError ? error.code : 'PROJECTION_INFRASTRUCTURE_UNAVAILABLE'})); message.retry({ delaySeconds: 10 }); }
    }
  },
} satisfies ExportedHandler<ProjectionEnv, ProjectionEvent>;
