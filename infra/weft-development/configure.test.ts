// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { configureDevelopment, validateDevelopment, WEFT_SOURCE_REVISION } from './configure.ts';
import { validateDeploymentSecrets } from '../deployment-secrets.ts';

const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
async function inputs() {
  const confidence = JSON.parse(await readFile(new URL('./confidence.example.json', import.meta.url), 'utf8'));
  const prefix = 'confidence-weft-dev-test';
  Object.assign(confidence, { accountId: '1'.repeat(32), deploymentPrefix: prefix, tenantId: prefix,
    artifactsNamespace: `${prefix}-sources`, objectBucket: `${prefix}-objects`, eventQueue: `${prefix}-events`, deadLetterQueue: `${prefix}-events-dlq`,
    projectionDatabase: { name: `${prefix}-projection`, id: '11111111-1111-4111-8111-111111111111' } });
  Object.assign(confidence.app, { origin: `https://${prefix}-app.test-owner.workers.dev`, workersDevSubdomain: 'test-owner', issuer: 'https://issuer.invalid', audience: 'test-only-audience', jwksUrl: 'https://issuer.invalid/jwks' });
  const binding = { id: 'test-binding', scope: { schemaVersion: 1, tenantId: prefix, projectId: confidence.app.defaultProjectId, projectIncarnation: 'test-incarnation' },
    workspaceId: `${prefix}-workspace`, alternativeId: null, sourceRepo: 'owned-weft-fixture', sourceRepositoryId: 'test-repository-id',
    sourceRef: 'refs/heads/main', sourceBase: 'a'.repeat(40), weftSourceRevision: WEFT_SOURCE_REVISION };
  return { confidence, connection: { schemaVersion: 2, workerName: `${prefix}-weft`, weftSourceRevision: WEFT_SOURCE_REVISION, replicaAudience: 'a'.repeat(64), bindings: [binding] } };
}

test('development input retains the existing closed defaults and pins the single Weft service boundary', async () => {
  const { confidence, connection } = await inputs();
  assert.deepEqual([confidence.maintenance, confidence.enablePi, confidence.enablePublication, confidence.app.bootstrapSubjects], [true, false, false, []]);
  assert.deepEqual(validateDevelopment(confidence, connection), connection);
  assert.deepEqual(validateDevelopment(confidence, { ...connection, bindings: [] }).bindings, []);
  for (const replicaAudience of [undefined, '', confidence.app.audience, 'REPLACE_WITH_AUDIENCE'])
    assert.throws(() => validateDevelopment(confidence, { ...connection, replicaAudience }), /WEFT_REPLICA_AUDIENCE_REQUIRED/);
  assert.throws(() => validateDevelopment({ ...confidence, app: { ...confidence.app, audience: connection.replicaAudience } }, connection), /WEFT_REPLICA_AUDIENCE_REQUIRED/);
});

test('development configuration rejects pilot reuse, unchecked destinations, incompatible pins and ambiguous project bindings', async () => {
  const { confidence, connection } = await inputs();
  for (const changed of [
    { ...confidence, deploymentPrefix: 'confidence-pilot' },
    { ...confidence, tenantId: 'pilot' },
    { ...confidence, artifactsNamespace: 'confidence' },
    { ...confidence, objectBucket: 'confidence-objects' },
    { ...confidence, projectionDatabase: { ...confidence.projectionDatabase, name: 'confidence-projection' } },
  ]) assert.throws(() => validateDevelopment(changed, connection), /WEFT_DEVELOPMENT_ISOLATION/);
  assert.throws(() => validateDevelopment({ ...confidence, app: { ...confidence.app, origin: 'https://confidence-pilot-app.test-owner.workers.dev' } }, connection), /WEFT_DEVELOPMENT_APP_ORIGIN/);
  const binding = connection.bindings[0]!;
  for (const changed of [
    { ...connection, workerName: 'https://untrusted.invalid' },
    { ...connection, endpoint: 'https://untrusted.invalid' },
    { ...connection, token: 'never-accept-credentials' },
    { ...connection, weftSourceRevision: 'b'.repeat(40) },
    { ...connection, bindings: [{ ...binding, scope: { ...binding.scope, tenantId: 'pilot' } }] },
    { ...connection, bindings: [{ ...binding, alternativeId: 'unsupported' }] },
    { ...connection, bindings: [{ ...binding, sourceBase: 'latest' }] },
    { ...connection, bindings: [{ ...binding, weftSourceRevision: 'c'.repeat(40) }] },
    { ...connection, bindings: [binding, { ...binding, id: 'duplicate-project' }] },
  ]) assert.throws(() => validateDevelopment(confidence, changed), /WEFT_/);
});

test('configuration delegates the original gates and binds the final authority config in the existing release manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-weft-development-'));
  try {
    const { confidence, connection } = await inputs();
    const basePath = join(directory, 'confidence.json'), connectionPath = join(directory, 'connection.json'), output = join(directory, 'generated');
    await writeFile(basePath, JSON.stringify(confidence)); await writeFile(connectionPath, JSON.stringify(connection));
    await configureDevelopment(basePath, connectionPath, output);
    const authorityRaw = await readFile(join(output, 'authority.json'), 'utf8'), authority = JSON.parse(authorityRaw);
    const appRaw = await readFile(join(output, 'app.json'), 'utf8'), app = JSON.parse(appRaw);
    const release = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
    assert.deepEqual(authority.services.filter((item: { binding: string }) => item.binding === 'WEFT'), [{ binding: 'WEFT', service: connection.workerName }]);
    assert.equal(authority.secrets.required.filter((name: string) => name === 'WEFT_SERVICE_TOKEN').length, 1);
    assert.deepEqual(JSON.parse(authority.vars.WEFT_CONNECTIONS), connection.bindings);
    assert.equal(authority.vars.WEFT_SERVICE_TOKEN, undefined);
    assert.equal(app.vars.WEFT_CONNECTIONS, undefined); assert.equal(app.services.some((item: { binding: string }) => item.binding === 'WEFT'), false);
    assert.equal(app.vars.AUTH_REPLICA_AUDIENCE, connection.replicaAudience);
    assert.equal(app.vars.AUTH_AUDIENCE, confidence.app.audience);
    assert.deepEqual([release.maintenance, release.enablePi, release.enablePublication], [true, false, false]);
    assert.equal(release.configs.authority, hash(authorityRaw));
    assert.equal(release.configs.app, hash(appRaw));
    assert.equal(release.weftDevelopment.replicaCredentialAuthority, 'weft-proxy-only');
    assert.equal(release.inputDigest, hash(await readFile(basePath, 'utf8')));
    assert.equal(release.weftDevelopment.connectionInputDigest, hash(await readFile(connectionPath, 'utf8')));
    assert.equal(release.weftDevelopment.sourceRevision, WEFT_SOURCE_REVISION);
    assert.equal(release.sourceDigests['infra/configure-pilot.ts'], hash(await readFile(resolve('infra/configure-pilot.ts'), 'utf8')));
    assert.equal((await stat(join(output, 'authority.json'))).mode & 0o077, 0);
    await assert.rejects(configureDevelopment(basePath, connectionPath, output), /OUTPUT_EXISTS/);
    const run = promisify(execFile), privateDirectory = join(directory, 'test-secrets');
    await run(process.execPath, ['--import', 'tsx', resolve('infra/configure-pilot.ts'), 'keys', privateDirectory]);
    const roles = ['authority', 'runner', 'evaluator', 'projector', 'app'];
    const configs = Object.fromEntries(await Promise.all(roles.map(async role => [role, JSON.parse(await readFile(join(output, `${role}.json`), 'utf8'))])));
    await assert.rejects(validateDeploymentSecrets(privateDirectory, configs), /PRIVATE_SECRET_FILE_SCHEMA/);
    const secretPath = join(privateDirectory, 'authority.secrets.json'), secrets = JSON.parse(await readFile(secretPath, 'utf8'));
    secrets.WEFT_SERVICE_TOKEN = 'synthetic-test-owner-token-not-for-deployment';
    await writeFile(secretPath, JSON.stringify(secrets), { mode: 0o600 });
    await validateDeploymentSecrets(privateDirectory, configs);
    await writeFile(join(output, 'authority.json'), authorityRaw + '\n');
    // The original release runner must reject a modified Weft config before packaging or network work.
    await assert.rejects(run(process.execPath, ['--import', 'tsx', resolve('infra/deploy-pilot.ts'), output, '--dry-run']),
      error => (error as { stderr?: string }).stderr?.includes('GENERATED_CONFIGURATION_CHANGED') === true);
    confidence.enablePublication = true;
    await writeFile(basePath, JSON.stringify(confidence));
    const refused = join(directory, 'refused');
    await assert.rejects(configureDevelopment(basePath, connectionPath, refused), /CONFIG_MAINTENANCE_FENCES|LIVE_PUBLICATION_EVIDENCE_REQUIRED/);
    await assert.rejects(readFile(join(refused, 'release.json')), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
