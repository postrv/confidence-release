// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectSummary } from '../../packages/project-model/src/types';
import { errorResponse, PlatformError } from '../shared/errors';
import { readDirectoryProjects, readProjectResponse } from './project-directory-read';

function summary(projectId: string, revision = '1'): ProjectSummary {
  return { projectId, projectIncarnation: 'incarnation-' + projectId, name: projectId, description: '', status: 'ACTIVE', revision,
    createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', roles: ['reader'], source: { status: 'EMPTY' }, checks: [],
    capabilities: { nativeWorkflow: false, repositoryChecks: false, publication: false, reason: 'Source import required' } };
}

test('directory reads membership freshly through revocation, absence and regrant', async () => {
  const indexed = ['legacy-pilot', 'revocable-project', 'never-accessible'];
  const members = new Map([['legacy-pilot', summary('legacy-pilot')], ['revocable-project', summary('revocable-project')]]);
  const reads: string[] = [];
  const read = async (id: string) => {
    reads.push(id); const project = members.get(id);
    return project ? Response.json(project) : errorResponse(new PlatformError('PROJECT_UNAVAILABLE', 404));
  };
  assert.deepEqual((await readDirectoryProjects(indexed, read)).map(project => project.projectId), indexed.slice(0, 2));
  members.delete('revocable-project');
  assert.deepEqual((await readDirectoryProjects(indexed, read)).map(project => project.projectId), ['legacy-pilot']);
  members.set('revocable-project', summary('revocable-project', '2'));
  const restored = await readDirectoryProjects(indexed, read);
  assert.deepEqual(restored.map(project => [project.projectId, project.revision]), [['legacy-pilot', '1'], ['revocable-project', '2']]);
  assert.deepEqual(reads, [...indexed, ...indexed, ...indexed]);
});

test('old authority unsupported operation fails the complete listing, then recovers after rollout', async () => {
  const indexed = ['accessible-project', 'legacy-pilot']; let updated = false;
  const read = async (id: string) => id === 'legacy-pilot' && !updated
    ? errorResponse(new PlatformError('UNSUPPORTED_OPERATION', 404)) : Response.json(summary(id));
  await assert.rejects(() => readDirectoryProjects(indexed, read), { code: 'PROJECT_DIRECTORY_UNAVAILABLE', status: 503 });
  updated = true;
  assert.deepEqual((await readDirectoryProjects(indexed, read)).map(project => project.projectId), indexed);
});

test('only a valid platform project-unavailable 404 is filtered', async t => {
  const invalid = [
    ['other platform code', () => errorResponse(new PlatformError('NOT_FOUND', 404))],
    ['non-JSON route error', () => new Response('Not Found', { status: 404 })],
    ['JSON string', () => Response.json('PROJECT_UNAVAILABLE', { status: 404 })],
    ['array envelope', () => Response.json([{ error: { code: 'PROJECT_UNAVAILABLE', message: 'PROJECT_UNAVAILABLE' } }], { status: 404 })],
    ['missing message', () => Response.json({ error: { code: 'PROJECT_UNAVAILABLE' } }, { status: 404 })],
    ['non-string message', () => Response.json({ error: { code: 'PROJECT_UNAVAILABLE', message: null } }, { status: 404 })],
    ['ambiguous extra field', () => Response.json({ error: { code: 'PROJECT_UNAVAILABLE', message: '', retry: true } }, { status: 404 })],
    ['duplicate error key', () => new Response('{"error":{"code":"UNSUPPORTED_OPERATION","message":""},"error":{"code":"PROJECT_UNAVAILABLE","message":""}}', { status: 404, headers: { 'content-type': 'application/json' } })],
    ['malformed JSON', () => new Response('{"error":', { status: 404, headers: { 'content-type': 'application/json' } })],
    ['invalid UTF-8', () => new Response(new Uint8Array([0xff]), { status: 404, headers: { 'content-type': 'application/json' } })],
    ['oversized error', () => Response.json({ error: { code: 'PROJECT_UNAVAILABLE', message: 'x'.repeat(4096) } }, { status: 404 })],
    ['wrong HTTP status', () => errorResponse(new PlatformError('PROJECT_UNAVAILABLE', 503))],
  ] as const;
  for (const [name, response] of invalid) await t.test(name, async () => {
    try { await readDirectoryProjects(['project'], async () => response()); assert.fail('Lookup failure was hidden'); }
    catch (error) {
      const result = errorResponse(error); assert.equal(result.status, 503);
      assert.deepEqual(await result.json(), { error: { code: 'PROJECT_DIRECTORY_UNAVAILABLE', message: 'PROJECT_DIRECTORY_UNAVAILABLE' } });
    }
  });
});

test('transport failure and unreadable error bodies produce retryable directory failures', async () => {
  for (const read of [
    async (): Promise<Response> => { throw new TypeError('RPC disconnected'); },
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('Body disconnected')); } }), { status: 404, headers: { 'content-type': 'application/json' } }),
  ]) await assert.rejects(() => readDirectoryProjects(['project'], read), { code: 'PROJECT_DIRECTORY_UNAVAILABLE', status: 503 });
});

test('fresh directory lookups retain ordering and the eight-request concurrency bound', async () => {
  const indexed = Array.from({ length: 19 }, (_, index) => 'project-' + index);
  let active = 0, maximum = 0;
  const projects = await readDirectoryProjects(indexed, async id => {
    active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--;
    return id === 'project-8' ? errorResponse(new PlatformError('PROJECT_UNAVAILABLE', 404)) : Response.json(summary(id));
  });
  assert.equal(maximum, 8); assert.equal(active, 0);
  assert.deepEqual(projects.map(project => project.projectId), indexed.filter(id => id !== 'project-8'));
});

test('a directory RPC deadline cancels late bodies and never dispatches the next batch', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let release!: (response: Response) => void, cancelled = 0;
  const requested: string[] = [];
  const pending = assert.rejects(readDirectoryProjects(Array.from({ length: 9 }, (_, i) => `project-${i}`), async id => {
    requested.push(id);
    return id === 'project-0' ? new Promise<Response>(resolve => { release = resolve; }) : Response.json(summary(id));
  }, 20), { code: 'PROJECT_DIRECTORY_UNAVAILABLE', status: 503 });
  await new Promise(resolve => setImmediate(resolve)); context.mock.timers.tick(20); await pending;
  release(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1); assert.equal(requested.length, 8); assert(!requested.includes('project-8'));
});

test('one directory response deadline includes headers and stalled body, without awaiting cancellation', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let release!: (response: Response) => void, cancelled = 0, continued = false;
  const operation = readProjectResponse(() => new Promise(resolve => { release = resolve; }), 100).then(() => { continued = true; });
  const rejected = assert.rejects(operation, { code: 'PROJECT_DIRECTORY_UNAVAILABLE', status: 503 });
  await new Promise(resolve => setImmediate(resolve)); context.mock.timers.tick(60);
  release(new Response(new ReadableStream({ cancel() { cancelled++; return new Promise<void>(() => {}); } }), { headers: { 'content-type': 'application/json' } }));
  await new Promise(resolve => setImmediate(resolve)); context.mock.timers.tick(40); await rejected;
  assert.equal(cancelled, 1); assert.equal(continued, false);
});

test('directory batches consume one shared list deadline', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const releases: (() => void)[] = []; const requested: string[] = [];
  const rejected = assert.rejects(readDirectoryProjects(Array.from({ length: 17 }, (_, i) => `project-${i}`), id => {
    requested.push(id); return new Promise(resolve => { releases.push(() => resolve(Response.json(summary(id)))); });
  }, 100), { code: 'PROJECT_DIRECTORY_UNAVAILABLE', status: 503 });
  await new Promise(resolve => setImmediate(resolve)); context.mock.timers.tick(60);
  releases.splice(0).forEach(release => release()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requested.length, 16);
  context.mock.timers.tick(40); await rejected;
  releases.splice(0).forEach(release => release()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requested.length, 16);
});

test('directory response overflow cancels without waiting and successful summaries use strict JSON', async () => {
  let cancelled = false;
  const oversized = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(readProjectResponse(async () => oversized), { code: 'PROJECT_DIRECTORY_UNAVAILABLE', status: 503 });
  assert.equal(cancelled, true);
  await assert.rejects(readProjectResponse(async () => new Response('{"projectId":"one","projectId":"two"}', { headers: { 'content-type': 'application/json' } })), { code: 'PROJECT_DIRECTORY_UNAVAILABLE', status: 503 });
});
