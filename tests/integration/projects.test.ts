// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../services/server.ts';
import type { ProjectCheck, ProjectSummary, RepositoryArchive } from '../../packages/project-model/src/types.ts';

function archive(): RepositoryArchive {
  const object = (type: 'commit' | 'tree' | 'blob', bytes: Buffer) => ({ oid: createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex'), type, dataBase64: bytes.toString('base64') });
  const blob = object('blob', Buffer.from('export const answer = 42;\n'));
  const tree = object('tree', Buffer.concat([Buffer.from('100644 index.mjs\0'), Buffer.from(blob.oid, 'hex')]));
  const head = object('commit', Buffer.from(`tree ${tree.oid}\nauthor Example <example@example.com> 1 +0000\ncommitter Example <example@example.com> 1 +0000\n\nOriginal source\n`));
  return { schemaVersion: 1, format: 'confidence-git-archive-v1', head: head.oid, branch: 'main', objects: [head, tree, blob], checks: [{ id: 'node-test', name: 'Node tests', argv: ['node', '--test'], cwd: '.', timeoutSeconds: 60, required: true, enabled: false, source: 'detected', evidenceClass: 'repository-check' }], warnings: [] };
}

test('local project lifecycle isolates imports, retains exact retries across restart, and enforces archive', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'confidence-projects-'));
  let running = await startServer({ port: 0, dataDir });
  t.after(async () => { await running.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (path: string, body?: unknown, commandId = 'create-a', context?: ProjectSummary) => {
    const response = await fetch(`http://127.0.0.1:${running.port}${path}`, body === undefined ? {} : { method: 'POST', headers: {
      'content-type': 'application/json', 'x-confidence-local-client': 'cli', 'idempotency-key': commandId,
      'if-platform-principal': 'local-pilot', ...(context ? { 'if-platform-revision': context.revision, 'if-platform-incarnation': context.projectIncarnation } : {}),
    }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() as any };
  };
  const directory = await request('/api/projects');
  assert.equal(directory.value.projects.length, 1);
  const legacy = directory.value.projects[0] as ProjectSummary;
  const created = await request('/api/projects', { name: 'Imported application', description: 'A separate repository' });
  assert.equal(created.status, 201); const project = created.value as ProjectSummary;
  assert.equal(project.source.status, 'EMPTY'); assert.equal(project.capabilities.nativeWorkflow, false);
  assert.deepEqual((await request('/api/projects', { name: 'Imported application', description: 'A separate repository' })).value, project);
  assert.equal((await request('/api/projects', { name: 'Different intent' })).status, 409);
  assert.equal((await request(`/api/projects/${project.projectId}/state`)).value.error, 'NATIVE_WORKFLOW_UNAVAILABLE');
  assert.equal((await request(`/api/projects/${legacy.projectId}/state`)).value.projectId, legacy.projectId);
  assert.equal((await request('/api/projects/__proto__')).status, 404);

  const source = archive();
  const imported = await request(`/api/projects/${project.projectId}/import`, { archive: source }, 'import-a', project);
  assert.equal(imported.status, 200); const importedProject = imported.value as ProjectSummary;
  assert.equal(importedProject.source.status, 'IMPORTED');
  assert.equal(importedProject.capabilities.publication, false); assert.equal(importedProject.capabilities.repositoryChecks, false);
  assert.deepEqual(importedProject.checks, source.checks);
  assert.equal(running.platform.state.projectId, legacy.projectId);
  assert.equal(running.platform.state.acceptedHead, (legacy.source as any).head);
  const archiveDigest = (importedProject.source as any).archiveDigest;
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'project-directory', 'archives', archiveDigest.slice(7) + '.json'), 'utf8')), source);
  assert.equal((await request(`/api/projects/${project.projectId}/import`, { archive: source }, 'import-second', importedProject)).status, 409);
  const sourceQuery = new URLSearchParams({ incarnation: project.projectIncarnation, archive: archiveDigest, view: 'tree' });
  const sourceUrl = `/api/projects/${project.projectId}/source?`;
  const tree = await request(sourceUrl + sourceQuery);
  assert.equal(tree.status, 200); assert.equal(tree.value.head, source.head); assert.equal(tree.value.entries[0].path, 'index.mjs');
  sourceQuery.set('view', 'file'); sourceQuery.set('path', 'index.mjs');
  const file = await request(sourceUrl + sourceQuery);
  assert.equal(file.status, 200); assert.equal(file.value.text, 'export const answer = 42;\n');
  sourceQuery.set('path', '../index.mjs'); assert.equal((await request(sourceUrl + sourceQuery)).status, 404);
  sourceQuery.delete('path'); sourceQuery.set('view', 'archive');
  const download = await fetch(`http://127.0.0.1:${running.port}${sourceUrl}${sourceQuery}`);
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition')!, /^attachment;/);
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.equal('sha256:' + createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex'), archiveDigest);
  sourceQuery.set('incarnation', 'stale'); assert.equal((await request(sourceUrl + sourceQuery)).status, 409);


  const races = await Promise.all(['first', 'second'].map((name, index) => request(`/api/projects/${project.projectId}/update`, { name, description: 'Changed' }, `rename-${index}`, importedProject)));
  assert.deepEqual(races.map(value => value.status).sort(), [200, 409]);
  assert.equal(races.find(value => value.status === 409)!.value.error, 'STALE_STATE');
  const renamed = (await request(`/api/projects/${project.projectId}`)).value as ProjectSummary;
  assert.equal(renamed.revision, String(BigInt(importedProject.revision) + 1n));
  const archived = await request(`/api/projects/${project.projectId}/archive`, {}, 'archive-a', renamed);
  assert.equal(archived.status, 200); assert.equal(archived.value.status, 'ARCHIVED');
  assert.equal((await request(`/api/projects/${project.projectId}/checks`, { checks: [] }, 'checks-archived', archived.value)).status, 409);
  const restored = await request(`/api/projects/${project.projectId}/restore`, {}, 'restore-a', archived.value);
  assert.equal(restored.value.status, 'ACTIVE');

  running.platform.state.admission = { gate: 'OPEN' };
  assert.equal((await request(`/api/projects/${legacy.projectId}/archive`, {}, 'archive-open', legacy)).status, 409);
  running.platform.state.admission.gate = 'CLOSED';
  const archivedLegacy = await request(`/api/projects/${legacy.projectId}/archive`, {}, 'archive-legacy', legacy);
  assert.equal(archivedLegacy.status, 200);
  assert.equal((await request('/api/demo', { mode: 'scripted' }, 'native-command')).value.error, 'PROJECT_ARCHIVED');
  assert.equal((await request(`/api/projects/${legacy.projectId}/demo`, { mode: 'scripted' }, 'native-command')).value.error, 'PROJECT_ARCHIVED');
  assert.equal((await request('/api/state')).status, 200);
  await running.close(); running = await startServer({ port: 0, dataDir });
  assert.deepEqual((await request(`/api/projects/${project.projectId}/import`, { archive: source }, 'import-a', project)).value, importedProject);
  assert.equal((await request(`/api/projects/${project.projectId}`)).value.status, 'ACTIVE');
  assert.equal((await request(`/api/projects/${legacy.projectId}`)).value.status, 'ARCHIVED');
});


test('imports preserve saved checks and initialize only an empty configuration across retry and restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'confidence-project-checks-'));
  let running = await startServer({ port: 0, dataDir });
  t.after(async () => { await running.close(); await rm(dataDir, { recursive: true, force: true }); });
  const saved: ProjectCheck[] = [{ id: 'node-test', name: 'Saved disabled test', argv: ['node', '--test', 'test/custom.mjs'], cwd: '.', timeoutSeconds: 37, required: false, enabled: false, source: 'manual', evidenceClass: 'repository-check' }];
  const suggestions: ProjectCheck[] = [
    { ...archive().checks[0]!, name: 'Detected enabled test', enabled: true, timeoutSeconds: 300 },
    { ...archive().checks[0]!, id: 'detected-only', name: 'Detected syntax check', argv: ['node', '--check', 'index.mjs'], enabled: true },
  ];
  const observations: { before: ProjectSummary; imported: ProjectSummary; archive: RepositoryArchive; commandId: string; currentChecks: ProjectCheck[] }[] = [];
  for (const [index, initial, detected] of [[0, saved, suggestions], [1, saved, []], [2, [], suggestions], [3, [], []]] as const) {
    const created = await running.projects.create({ commandId: `checks-create-${index}`, body: { name: `Check preservation ${index}` } });
    const configured = await running.projects.command(created.projectId, { commandId: `configure-${index}`, expectedRevision: created.revision, expectedIncarnation: created.projectIncarnation, operation: 'checks', body: { checks: initial } });
    const source = archive(); source.checks = structuredClone([...detected]);
    const commandId = `checks-import-${index}`;
    const intent = { commandId, expectedRevision: configured.revision, expectedIncarnation: configured.projectIncarnation, operation: 'import' as const, body: { archive: source } };
    const imported = await running.projects.command(configured.projectId, intent);
    const expected = initial.length ? [...initial] : [...detected];
    assert.deepEqual(imported.checks, expected);
    assert.equal(imported.source.status, 'IMPORTED');
    if (imported.source.status !== 'IMPORTED') throw new Error('Source was not imported');
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'project-directory', 'archives', imported.source.archiveDigest.slice(7) + '.json'), 'utf8')), source, 'saved configuration must not rewrite the retained source archive');
    assert.deepEqual(await running.projects.command(configured.projectId, intent), imported);
    const currentChecks = [{ ...saved[0]!, name: 'Edited after import' }];
    await running.projects.command(imported.projectId, { commandId: `edit-after-${index}`, expectedRevision: imported.revision, expectedIncarnation: imported.projectIncarnation, operation: 'checks', body: { checks: currentChecks } });
    assert.deepEqual(await running.projects.command(configured.projectId, intent), imported, 'replay returns its original acknowledgement');
    assert.deepEqual(running.projects.get(imported.projectId).checks, currentChecks, 'replay must not restore older configuration');
    observations.push({ before: configured, imported, archive: source, commandId, currentChecks });
  }
  await running.close(); running = await startServer({ port: 0, dataDir });
  for (const item of observations) {
    assert.deepEqual(running.projects.get(item.imported.projectId).checks, item.currentChecks);
    assert.deepEqual(await running.projects.command(item.before.projectId, { commandId: item.commandId, expectedRevision: item.before.revision, expectedIncarnation: item.before.projectIncarnation, operation: 'import', body: { archive: item.archive } }), item.imported);
  }
});
