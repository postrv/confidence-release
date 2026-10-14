// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collaborationConfigurations, assertHubDeploymentState, withHubDeploymentLock } from './collaboration-development';

const input = { accountId: 'a'.repeat(32), prefix: 'confidence-collab-dev-owned', workersDevSubdomain: 'owned', objectBucket: 'confidence-collab-dev-owned-objects', issuer: 'https://owned.cloudflareaccess.com', audience: null, maintenance: true };
test('closed collaboration configuration has only private authority, R2 and application assets', () => {
  const config = collaborationConfigurations('/owned/confidence', input);
  assert.equal(config.app.vars.APP_ORIGIN, 'https://confidence-collab-dev-owned-app.owned.workers.dev');
  assert.equal(config.authority.workers_dev, false); assert.equal(config.app.preview_urls, false);
  assert.equal(config.app.vars.MAINTENANCE_MODE, 'true'); assert.equal(config.app.vars.PROJECT_HUB_ENABLED, 'true');
  assert.equal(config.app.vars.COLLABORATION_ONLY, 'true');
  for (const role of ['app', 'authority'] as const) {
    for (const forbidden of ['artifacts', 'queues', 'containers', 'ai', 'routes']) assert.equal(forbidden in config[role], false);
    assert.deepEqual(config[role].secrets.required, ['APP_SERVICE_TOKEN']);
    assert.equal(config[role].vars.CONDITIONAL_PUBLICATION_VERIFIED, 'false');
  }
  assert.deepEqual(config.app.services, [{ binding: 'AUTHORITY', service: 'confidence-collab-dev-owned-authority' }]);
  assert.equal('services' in config.authority, false);
});
test('opening requires an observed Access audience and isolated resource names', () => {
  assert.throws(() => collaborationConfigurations('/owned/confidence', { ...input, maintenance: false }), /HUB_ACCESS_REQUIRED/);
  const open = collaborationConfigurations('/owned/confidence', { ...input, maintenance: false, audience: 'b'.repeat(64) });
  assert.equal(open.app.vars.AUTH_AUDIENCE, 'b'.repeat(64));
  for (const changed of [{ prefix: 'confidence-pilot' }, { objectBucket: 'weft-content-dev' }, { issuer: 'https://evil.test' }, { accountId: 'invalid' }, { workersDevSubdomain: '../other' }])
    assert.throws(() => collaborationConfigurations('/owned/confidence', { ...input, ...changed }));
});
test('an interrupted deployment fences every later release in the same private root', () => {
  assert.doesNotThrow(() => assertHubDeploymentState(null, input.accountId, 'https://owned.test'));
  assert.doesNotThrow(() => assertHubDeploymentState({ state: 'ACKNOWLEDGED', accountId: input.accountId, origin: 'https://owned.test' }, input.accountId, 'https://owned.test'));
  for (const state of ['STARTED', 'UNKNOWN', 'FAILED']) assert.throws(() => assertHubDeploymentState({ state, accountId: input.accountId, origin: 'https://owned.test' }, input.accountId, 'https://owned.test'), /HUB_PRIOR_DEPLOYMENT_UNRESOLVED/);
  assert.throws(() => assertHubDeploymentState({ state: 'ACKNOWLEDGED', accountId: input.accountId, origin: 'https://other.test' }, input.accountId, 'https://owned.test'), /HUB_PRIOR_DEPLOYMENT_UNRESOLVED/);
});
test('different prepared releases cannot upload concurrently in the same deployment root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'confidence-hub-deploy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstDirectory = join(root, 'first'), secondDirectory = join(root, 'second');
  await mkdir(firstDirectory); await mkdir(secondDirectory);
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const first = withHubDeploymentLock(firstDirectory, true, async () => { entered(); await pending; });
  await started;
  let secondUploadStarted = false;
  try {
    await assert.rejects(withHubDeploymentLock(secondDirectory, true, async () => { secondUploadStarted = true; }), /DEPLOYMENT_LOCK_PRESENT/);
    assert.equal(secondUploadStarted, false);
  } finally { finish(); await first; }
  await assert.rejects(access(join(root, '.deployment.lock')), { code: 'ENOENT' });
  await withHubDeploymentLock(secondDirectory, true, async () => { secondUploadStarted = true; });
  assert.equal(secondUploadStarted, true);
});
test('operation failure releases the owned lock and local packaging does not take the live lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'confidence-hub-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'prepared'); await mkdir(directory);
  await assert.rejects(withHubDeploymentLock(directory, true, async () => { throw Error('OWNED_CALLBACK_FAILURE'); }), /OWNED_CALLBACK_FAILURE/);
  await assert.rejects(access(join(root, '.deployment.lock')), { code: 'ENOENT' });
  await withHubDeploymentLock(directory, true, async () => {
    await withHubDeploymentLock(directory, false, async () => {});
  });
  await assert.rejects(access(join(root, '.deployment.lock')), { code: 'ENOENT' });
});
